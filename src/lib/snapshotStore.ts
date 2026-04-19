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
   * snapshot fetch. `null` until the first fetch resolves, or if every
   * payload so far has been missing `generated_at_ms` (old-client fallback,
   * pre-ingest-44caae5).
   */
  generatedAtMs: number | null;
  /**
   * Difference (ms) between server time at fetch-receipt and the client's
   * local clock. Added to `Date.now()` to produce `serverNow()`. `0` when
   * we have no authoritative signal to calibrate against (before first
   * fetch, or when `generated_at_ms` is absent).
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

/**
 * Publish the result of a successful snapshot fetch. If
 * `generatedAtMs` is null or non-finite (old payload), we preserve the
 * previous `generatedAtMs` but set `clockOffset` to 0 — staleness
 * detection degrades to "cannot tell" rather than firing spuriously.
 */
export function publishSnapshot(generatedAtMs: number | null): void {
  const now = Date.now();
  const hasTime = generatedAtMs !== null && Number.isFinite(generatedAtMs) && generatedAtMs > 0;
  const next: SnapshotState = hasTime
    ? { generatedAtMs, clockOffset: (generatedAtMs as number) - now }
    : { generatedAtMs: currentState.generatedAtMs, clockOffset: 0 };
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
