/**
 * Tests for the AbortController + retry utility that powers the airtight
 * refresh loop (swarm audit 2026-04-18, Tier 1 #2c).
 *
 * Coverage targets the three behaviors that matter operationally:
 *   (a) retry backoff sequence fires at 250 / 1000 / 2000 ms; third failure
 *       throws FetchRetryError.
 *   (b) AbortError (intentional abort by caller) is NOT retried and
 *       propagates out cleanly.
 *   (c) Non-2xx responses retry identically to network throws — a 503 from
 *       the Worker is the same class of failure as a TCP reset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJsonWithRetry, FetchRetryError, isAbortError } from './fetchWithRetry';

describe('fetchJsonWithRetry', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns parsed JSON on a successful first attempt', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ hello: 'world' }),
    });
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    const result = await fetchJsonWithRetry('/x', { sleep });
    expect(result).toEqual({ hello: 'world' });
    // No retry → no sleep call.
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries with 250 / 1000 / 2000 ms backoff and gives up after 3 attempts', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // Three network-level failures in a row.
    fetchMock
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockRejectedValueOnce(new Error('boom 3'));

    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    await expect(fetchJsonWithRetry('/x', { sleep })).rejects.toBeInstanceOf(FetchRetryError);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First failure -> sleep 250; second failure -> sleep 1000. Third failure
    // throws (no sleep after the final attempt).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBe(250);
    expect(sleep.mock.calls[1][0]).toBe(1_000);
  });

  it('retries on non-2xx responses (503, 500, etc) the same as on throws', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    const result = await fetchJsonWithRetry('/x', { sleep });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('surfaces the retry delay sequence [250, 1000, 2000] from constants', async () => {
    // A 4-attempt override (via maxAttempts) exercises the third delay slot
    // so we can verify the schedule matches audit-documented constants.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockRejectedValueOnce(new Error('c'))
      .mockRejectedValueOnce(new Error('d'));

    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    await expect(fetchJsonWithRetry('/x', { sleep, maxAttempts: 4 })).rejects.toBeInstanceOf(
      FetchRetryError,
    );
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0][0]).toBe(250);
    expect(sleep.mock.calls[1][0]).toBe(1_000);
    expect(sleep.mock.calls[2][0]).toBe(2_000);
  });

  it('does NOT retry when the caller aborts (AbortError propagates)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            const err = new DOMException('aborted', 'AbortError');
            reject(err);
          });
        }),
    );

    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    const p = fetchJsonWithRetry('/x', { signal: controller.signal, sleep });
    controller.abort();

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }

    expect(isAbortError(caught)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not mistake a non-abort error for an abort', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockRejectedValueOnce(new TypeError('network ded'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ n: 1 }) });

    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    const result = await fetchJsonWithRetry('/x', { sleep });
    expect(result).toEqual({ n: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('invokes onResponse with the raw Response before consuming the body', async () => {
    const headers = new Headers({ date: 'Wed, 19 Apr 2026 12:00:00 GMT', age: '12' });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers,
      json: async () => ({ hello: 'world' }),
    });
    const onResponse = vi.fn();
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
    const result = await fetchJsonWithRetry('/x', { sleep, onResponse });
    expect(result).toEqual({ hello: 'world' });
    expect(onResponse).toHaveBeenCalledTimes(1);
    const resp = onResponse.mock.calls[0][0] as Response;
    expect(resp.headers.get('date')).toBe('Wed, 19 Apr 2026 12:00:00 GMT');
    expect(resp.headers.get('age')).toBe('12');
  });

  it('a throwing onResponse hook does not fail the fetch', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = { hello: 'world' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => body,
    });

    await expect(
      fetchJsonWithRetry('/x', {
        sleep: vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve()),
        onResponse: () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Fix 3 (Codex review, Suggestion → prod bug): a hung fetch previously
  // never resolved/rejected, so the retry path was never reached and the
  // caller kept scheduling overlapping polls. The per-attempt timeout
  // forces a deterministic fail-over window.
  describe('per-attempt timeout (FETCH_TIMEOUT_MS)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts a hung fetch after timeoutMs and kicks the retry path', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

      // First two attempts hang forever UNTIL their per-attempt signal
      // aborts, at which point they reject with an AbortError. Third
      // attempt succeeds.
      const hangingImpl = (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason = init.signal?.reason;
            reject(reason ?? new DOMException('aborted', 'AbortError'));
          });
        });
      fetchMock
        .mockImplementationOnce(hangingImpl)
        .mockImplementationOnce(hangingImpl)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });

      const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
      const p = fetchJsonWithRetry('/x', { sleep, timeoutMs: 5_000 });

      // Advance past the first two per-attempt timeouts. Each timeout
      // aborts the attempt controller, causing the hanging fetch to
      // reject with AbortError — which our handler recognizes as a
      // timeout (not a caller abort) and retries.
      await vi.advanceTimersByTimeAsync(5_000); // triggers attempt-1 timeout
      await vi.advanceTimersByTimeAsync(5_000); // triggers attempt-2 timeout

      const result = await p;
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Two retries (after attempts 1 and 2). Sleep is injected so the
      // retry backoff is instant under our vi-fake-timer control.
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('gives up with FetchRetryError after all attempts time out', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const hangingImpl = (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason = init.signal?.reason;
            reject(reason ?? new DOMException('aborted', 'AbortError'));
          });
        });
      fetchMock.mockImplementation(hangingImpl);

      const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
      const p = fetchJsonWithRetry('/x', { sleep, timeoutMs: 1_000 });
      // Swallow rejection at the mocked-promise layer so Node doesn't flag
      // an unhandled rejection while we're driving fake timers.
      const expectation = expect(p).rejects.toBeInstanceOf(FetchRetryError);

      // Drive through maxAttempts per-attempt timeouts.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('caller abort during a hung fetch propagates as AbortError with no retry', async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const controller = new AbortController();
      fetchMock.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const reason = init.signal?.reason;
            reject(reason ?? new DOMException('aborted', 'AbortError'));
          });
        });
      });

      const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve());
      const p = fetchJsonWithRetry('/x', {
        signal: controller.signal,
        sleep,
        timeoutMs: 30_000,
      });

      // Let the microtask queue settle before aborting so the fetch has
      // wired up its abort listener.
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();

      let caught: unknown;
      try {
        await p;
      } catch (err) {
        caught = err;
      }
      expect(isAbortError(caught)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});
