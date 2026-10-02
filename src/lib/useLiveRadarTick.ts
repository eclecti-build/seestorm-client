'use client';

/**
 * Live radar refresh clock: returns a counter bumped once per
 * POLL_INTERVAL_MS while `enabled`, and each bump is one gated live refresh
 * (see the radar effect in WeatherMap).
 *
 * It runs on its own timer, independent of every `/v1/*` request: when the
 * history poll drove live refreshes, a failing `/v1/history` froze live radar
 * silently (no load, so no dots; no stale banner either, which follows the
 * live-alerts fetch). It is the ONLY live refresh trigger, so the tile host
 * sees one refresh per interval. The caller enables it once the map is ready
 * and live, and entering live already loads the live frame, so the first tick
 * is a full interval after that load. A tab becoming visible again ticks at
 * once only when the throttled interval left a tick overdue, then restarts
 * the interval from there.
 */

import { useEffect, useState } from 'react';
import { POLL_INTERVAL_MS } from './constants';

// Whether a tab becoming visible again should fire a live refresh tick now.
// Hidden tabs throttle the POLL_INTERVAL_MS interval, so a tick may be
// overdue; one that isn't is left to the interval, so switching tabs never
// adds a second refresh to an interval.
export function liveRadarTickOverdue(lastTickAt: number, now: number): boolean {
  return now - lastTickAt >= POLL_INTERVAL_MS;
}

export function useLiveRadarTick(enabled: boolean): number {
  const [tickCount, setTickCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let lastTickAt = Date.now();
    const tick = (): void => {
      lastTickAt = Date.now();
      setTickCount((t) => t + 1);
    };
    let interval = setInterval(tick, POLL_INTERVAL_MS);
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (!liveRadarTickOverdue(lastTickAt, Date.now())) return;
      clearInterval(interval);
      tick();
      interval = setInterval(tick, POLL_INTERVAL_MS);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled]);

  return tickCount;
}
