'use client';

/**
 * Binary staleness banner — the user-visible third leg of the three-detector
 * liveness system (swarm audit 2026-04-18, Tier 1 #2c; Open Decisions #11).
 *
 * Model is deliberately two-state: FRESH renders nothing, BROKEN renders
 * a red banner with copy that tells the user to go elsewhere. Per the
 * settled decision, there is NO yellow/amber middle tier — a safety app
 * must not encourage tolerance of stale data. If the data is over 90s
 * behind the server clock, we are honest about it.
 *
 * Mount at the root layout so the banner covers every route (about page,
 * etc.), not just the map. The banner subscribes to the snapshot store;
 * WeatherMap publishes into the store on every successful fetch. Until
 * the first publish, we render nothing (no "loading" state — the map
 * itself already has one).
 */

import { useEffect, useState } from 'react';
import { STALENESS_BANNER_COPY, STALENESS_CRITICAL_MS } from '@/lib/constants';
import { useSnapshotState } from '@/lib/snapshotStore';

/**
 * Check if the current snapshot is stale relative to the server clock.
 * Exported for unit testing the threshold logic without a full DOM render.
 */
export function isStale(
  generatedAtMs: number | null,
  serverNowMs: number,
  thresholdMs: number = STALENESS_CRITICAL_MS,
): boolean {
  if (generatedAtMs == null || !Number.isFinite(generatedAtMs)) return false;
  return serverNowMs - generatedAtMs >= thresholdMs;
}

/**
 * Props are optional — the default path reads from the module-level
 * snapshot store. Explicit props let tests inject a frozen state without
 * reaching into the store singleton.
 */
export interface StalenessBannerProps {
  generatedAtMs?: number | null;
  serverNow?: () => number;
  /** Test-only override of the staleness threshold. Defaults to 90_000. */
  thresholdMs?: number;
  /** Test-only override of the re-check interval (ms). Defaults to 1_000. */
  tickMs?: number;
}

export default function StalenessBanner({
  generatedAtMs: generatedAtMsProp,
  serverNow: serverNowProp,
  thresholdMs = STALENESS_CRITICAL_MS,
  tickMs = 1_000,
}: StalenessBannerProps = {}) {
  const storeState = useSnapshotState();
  const generatedAtMs =
    generatedAtMsProp !== undefined ? generatedAtMsProp : storeState.generatedAtMs;
  // Build a serverNow from the store's offset when the caller hasn't provided
  // one. This keeps the default path zero-config for the root-layout mount.
  const effectiveServerNow = serverNowProp ?? (() => Date.now() + storeState.clockOffset);

  // The banner needs to re-evaluate even without fresh props — between
  // polls the clock marches forward and a FRESH snapshot becomes BROKEN.
  // Tick every second so the threshold crossing is reflected promptly.
  const [, setTick] = useState<number>(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const stale = isStale(generatedAtMs ?? null, effectiveServerNow(), thresholdMs);
  if (!stale) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="staleness-banner"
      className="fixed top-0 inset-x-0 z-50 bg-red-600 text-white text-center text-sm sm:text-base font-semibold px-4 py-2 shadow-lg"
      style={{
        paddingTop: 'calc(0.5rem + env(safe-area-inset-top))',
        paddingLeft: 'calc(1rem + env(safe-area-inset-left))',
        paddingRight: 'calc(1rem + env(safe-area-inset-right))',
      }}
    >
      {STALENESS_BANNER_COPY}
    </div>
  );
}
