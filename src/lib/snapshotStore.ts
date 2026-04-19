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
}

const INITIAL_STATE: SnapshotState = {
  generatedAtMs: null,
  clockOffset: 0,
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
  const next: SnapshotState = hasTime
    ? { generatedAtMs, clockOffset: (generatedAtMs as number) - now }
    : // Live fetch with missing/invalid generated_at_ms: clear both fields so
      // the banner degrades to "cannot tell" rather than comparing wall-clock
      // time against a stale timestamp preserved from a previous publish.
      { generatedAtMs: null, clockOffset: 0 };
  // Avoid spurious notifications when nothing actually changed.
  if (
    next.generatedAtMs === currentState.generatedAtMs &&
    next.clockOffset === currentState.clockOffset
  ) {
    return;
  }
  currentState = next;
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
