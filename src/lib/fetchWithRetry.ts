/**
 * AbortController-guarded fetch with exponential backoff retry.
 *
 * Swarm audit 2026-04-18, Tier 1 #2c. The previous fetch loop was
 * fire-and-forget: first network blip dropped the cycle silently and waited
 * 30s for the next `setInterval` tick. Under the binary staleness model
 * (Open Decisions #11), that behavior was the reason the 90s banner
 * threshold would have fired regularly on non-safety-critical jitter.
 *
 * Behavior:
 *   - Each attempt runs with the caller's `AbortSignal` (if any). Callers
 *     pass an `AbortController` they own — we never construct a new signal
 *     internally, because the component-level controller must abort on
 *     unmount AND on state transitions (live ↔ historical).
 *   - Network errors (throws) AND non-2xx responses BOTH trigger a retry.
 *     The settled stance is that a 503 from the Worker is the same class of
 *     failure as a TCP reset from the CDN — both mean "try again, something
 *     is blipping upstream."
 *   - `AbortError` is NOT retried. Aborts are intentional (the caller wants
 *     this fetch gone), so retrying would fight the caller.
 *   - After `FETCH_RETRY_MAX_ATTEMPTS` total attempts (= 1 initial + up to
 *     `FETCH_RETRY_DELAYS_MS.length` retries), the last error is thrown.
 *     Delays: 250ms, 1000ms, 2000ms.
 */

import { FETCH_RETRY_DELAYS_MS, FETCH_RETRY_MAX_ATTEMPTS, FETCH_TIMEOUT_MS } from './constants';

export class FetchRetryError extends Error {
  readonly attempts: number;
  readonly status?: number;
  constructor(message: string, attempts: number, status?: number) {
    super(message);
    this.name = 'FetchRetryError';
    this.attempts = attempts;
    this.status = status;
  }
}

export interface FetchWithRetryOptions {
  /**
   * Caller-owned signal. Aborting short-circuits the retry loop with an
   * `AbortError` (DOMException) that the caller is expected to catch and
   * treat as a clean shutdown, not a failure.
   */
  signal?: AbortSignal;
  /**
   * Override the retry delays (ms) for tests. In production this always
   * resolves to the constants-module value so the schedule is observable
   * from one source of truth.
   */
  retryDelaysMs?: readonly number[];
  /** Override max attempts for tests. Defaults to FETCH_RETRY_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /**
   * Injectable sleep for tests (so the retry schedule is reproducible under
   * vitest fake timers). Defaults to `setTimeout`.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Per-attempt timeout (ms). Defaults to `FETCH_TIMEOUT_MS`. A hung fetch
   * that neither resolves nor rejects would otherwise leave the caller's
   * polling loop scheduling overlapping requests forever (Codex review —
   * Fix 3). When the timeout fires the attempt aborts and the retry path
   * picks up normally.
   */
  timeoutMs?: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signalAbortReason(signal));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signalAbortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function signalAbortReason(signal?: AbortSignal): unknown {
  // Use native `reason` when present (modern browsers); fall back to a
  // DOMException-shaped error so callers' `err.name === 'AbortError'`
  // checks keep working.
  const reason = signal?.reason;
  if (reason !== undefined && reason !== null) return reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

/**
 * Fetch a JSON response with retry. On final failure throws either the
 * underlying abort error (if the caller aborted) or a `FetchRetryError`
 * describing the last failure.
 */
export async function fetchJsonWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<unknown> {
  const delays = options.retryDelaysMs ?? FETCH_RETRY_DELAYS_MS;
  const maxAttempts = options.maxAttempts ?? FETCH_RETRY_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const callerSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  let lastErr: unknown;
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (callerSignal?.aborted) throw signalAbortReason(callerSignal);

    // Build a per-attempt AbortController that aborts when EITHER the
    // caller's signal aborts OR the per-attempt timeout fires. We track
    // which of the two fired so we can distinguish "caller wants out"
    // (propagate, no retry) from "this attempt hung" (retry normally).
    const attemptController = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      attemptController.abort(
        typeof DOMException !== 'undefined'
          ? new DOMException(`fetch exceeded ${timeoutMs}ms`, 'TimeoutError')
          : Object.assign(new Error(`fetch exceeded ${timeoutMs}ms`), { name: 'TimeoutError' }),
      );
    }, timeoutMs);
    const onCallerAbort = () => attemptController.abort(signalAbortReason(callerSignal));
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const resp = await fetch(url, { signal: attemptController.signal });
      if (!resp.ok) {
        lastStatus = resp.status;
        lastErr = new Error(`HTTP ${resp.status}`);
      } else {
        return (await resp.json()) as unknown;
      }
    } catch (err) {
      // Caller-driven aborts: propagate unchanged (do not retry).
      if (callerSignal?.aborted) throw signalAbortReason(callerSignal);
      // Per-attempt timeout: this surfaces as an AbortError from fetch
      // because we aborted `attemptController`. We must NOT treat that as
      // a caller abort — record it as the last error so the retry path
      // engages instead of propagating out.
      if (timedOut) {
        lastErr = err instanceof Error ? err : new Error(`fetch exceeded ${timeoutMs}ms`);
      } else if (isAbortError(err)) {
        // A non-timeout, non-caller abort reached us — preserve original
        // behavior: treat as an intentional abort and propagate.
        throw err;
      } else {
        lastErr = err;
      }
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }

    // Before sleeping, check whether we'll bother. If this was the last
    // attempt there's no delay to wait on — fall through to the throw.
    if (attempt < maxAttempts - 1) {
      const delay = delays[Math.min(attempt, delays.length - 1)];
      await sleep(delay, callerSignal);
    }
  }

  throw new FetchRetryError(
    `fetch failed after ${maxAttempts} attempts: ${describeError(lastErr)}`,
    maxAttempts,
    lastStatus,
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}

/** Re-exported for tests that need to distinguish abort from failure. */
export { isAbortError };
