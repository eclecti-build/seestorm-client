'use client';

/**
 * Tiny pub/sub for sharing the latest snapshot's `generated_at_ms` and
 * `clockOffset` between the WeatherMap (publisher, the component that owns
 * the fetch loop) and the StalenessBanner (subscriber, mounted at the root
 * layout so the banner covers every route).
 *
 * We avoid React Context here because:
 *   1. The root layout renders on the server and the banner is a client
 *      component; threading context through a dynamic import of WeatherMap
 *      would force WeatherMap above the banner in the tree, reordering a
 *      map that's deliberately nested under `<main>`.
 *   2. `useSyncExternalStore` gives us tear-free subscriptions with no
 *      renders-in-setState concerns under React 19's strict mode — exactly
 *      what we want for an asynchronous publisher feeding a ticker-driven
 *      consumer (1s interval in StalenessBanner).
 *
 * See swarm audit 2026-04-18, Tier 1 #2c and Open Decisions #11.
 */

import { useSyncExternalStore } from 'react';

export interface SnapshotState {
  /**
   * Server-produced epoch-ms timestamp from the most recently-successful
   * LIVE snapshot fetch. `null` until the first live fetch resolves, or
   * when the most recent live payload was missing `generated_at_ms`
   * (old-client fallback, pre-ingest-44caae5). Historical scrubs never
   * touch this field — see `publishSnapshot` below.
   */
  generatedAtMs: number | null;
  /**
   * Difference (ms) between server time at fetch-receipt and the client's
   * local clock. Added to `Date.now()` to produce `serverNow()`. `0` when
   * we have no authoritative signal to calibrate against (before first
   * fetch, or when `generated_at_ms` is absent).
   *
   * Known limitation (documented in swarm audit 2026-04-18 and Codex
   * pass 2): `generated_at_ms` is snapshot-generation time, not wall-clock
   * server-now, so under SWR cache max-age ~60s the offset can under-
   * estimate the true skew by up to the cache age. Accepted trade-off:
   * avoids an extra round-trip or Date-header dependency.
   */
  clockOffset: number;
  /**
   * Consecutive LIVE fetch failures (fetchLive's catch path, after
   * fetchWithRetry's internal retries are already exhausted) since the last
   * successful live fetch. Reset to 0 by every successful `publishSnapshot`
   * call with `isLive: true` — including one whose payload is missing
   * `generated_at_ms`, because a successful HTTP round-trip is not a fetch
   * failure. Historical fetches never touch this field.
   */
  consecutiveLiveFailures: number;
}

const INITIAL_STATE: SnapshotState = {
  generatedAtMs: null,
  clockOffset: 0,
  consecutiveLiveFailures: 0,
};

let currentState: SnapshotState = INITIAL_STATE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export interface PublishSnapshotOptions {
  /**
   * Whether this publish originates from a LIVE fetch. Historical scrubs
   * MUST pass `false` — they carry intentionally old `generated_at_ms`
   * values that would both trip the staleness banner (Fix: Codex pass 2
   * Critical) AND poison the clock offset (same root cause).
   *
   * Defaults to `false` so any future caller that forgets to specify the
   * flag degrades safely rather than silently polluting the store.
   */
  isLive: boolean;
}

/**
 * Publish the result of a successful snapshot fetch.
 *
 * Semantics by (`isLive`, `generatedAtMs`):
 *   - `isLive: true` + valid ts  → update both `generatedAtMs` + `clockOffset`.
 *   - `isLive: true` + null/bad  → CLEAR `generatedAtMs` to `null` AND zero
 *     the offset. The banner thus degrades to "cannot tell" instead of
 *     carrying forward a stale timestamp that trips ~90s later even while
 *     fresh (but untimestamped) snapshots keep arriving. This is the Fix 1
 *     root cause from the Codex review.
 *   - `isLive: false`            → NO-OP. Historical fetches must not
 *     influence the live-data honesty signal (staleness banner) or the
 *     clock-offset calibration.
 */
export function publishSnapshot(
  generatedAtMs: number | null,
  options: PublishSnapshotOptions,
): void {
  // Historical fetches: touch nothing. The staleness banner reflects the
  // freshness of the last LIVE fetch, not whatever the user is scrubbed to.
  if (!options.isLive) return;

  const now = Date.now();
  const hasTime = generatedAtMs !== null && Number.isFinite(generatedAtMs) && generatedAtMs > 0;

  // Reset unconditionally on every successful LIVE publish — a successful
  // HTTP round-trip is not a fetch failure, even one whose payload is
  // missing generated_at_ms (the !hasTime branch below). This is computed
  // BEFORE the dedup comparison and folded into `next` up front so it can
  // never be silently dropped by the early `return` below: if the reset
  // were instead applied only after a dedup check keyed on
  // generatedAtMs/clockOffset, a republish of an UNCHANGED generatedAtMs/
  // clockOffset (see snapshotStore.test.ts's "unchanged from the current
  // state" test) would hit that early return and leave
  // consecutiveLiveFailures stuck at its pre-success value forever.
  const consecutiveLiveFailures = 0;
  const failuresChanged = consecutiveLiveFailures !== currentState.consecutiveLiveFailures;

  const next: SnapshotState = hasTime
    ? { generatedAtMs, clockOffset: (generatedAtMs as number) - now, consecutiveLiveFailures }
    : // Live fetch with missing/invalid generated_at_ms: clear both fields so
      // the banner degrades to "cannot tell" rather than comparing wall-clock
      // time against a stale timestamp preserved from a previous publish.
      { generatedAtMs: null, clockOffset: 0, consecutiveLiveFailures };
  // Avoid spurious notifications when NOTHING actually changed — but a
  // changed failure counter counts as a change requiring emit; otherwise a
  // publish that resets consecutiveLiveFailures from a nonzero value back
  // to 0 while generatedAtMs/clockOffset happen to be unchanged would
  // never notify AlertsPanel's degraded-notice subscriber that the reset
  // happened.
  if (
    next.generatedAtMs === currentState.generatedAtMs &&
    next.clockOffset === currentState.clockOffset &&
    !failuresChanged
  ) {
    return;
  }
  currentState = next;
  emit();
}

/**
 * Record a failed LIVE fetch attempt. Lets `AlertsPanel` distinguish "no
 * active alerts" (data arrived, list is empty) from "alert data unavailable"
 * (the fetch itself is failing) — including a session that has NEVER had a
 * successful fetch, where `allAlerts` is still its initial `[]`. Deliberately
 * separate from `publishSnapshot`: a failed fetch has no `generatedAtMs` to
 * publish, and must not touch the staleness banner's binary FRESH/BROKEN
 * state (StalenessBanner.tsx header comment) — the banner's "cannot tell"
 * (`generatedAtMs: null`) state and this counter are independent signals a
 * caller may combine, not one merged three-way state.
 */
export function publishLiveFetchFailure(): void {
  currentState = {
    ...currentState,
    consecutiveLiveFailures: currentState.consecutiveLiveFailures + 1,
  };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SnapshotState {
  return currentState;
}

function getServerSnapshot(): SnapshotState {
  return INITIAL_STATE;
}

/** React hook for subscribing to the latest published snapshot state. */
export function useSnapshotState(): SnapshotState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test-only reset. Not exported for production use. */
export function __resetSnapshotStoreForTests(): void {
  currentState = INITIAL_STATE;
  listeners.clear();
}
