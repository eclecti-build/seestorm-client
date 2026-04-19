'use client';

/**
 * Clock-skew calibration for relative-time labels and staleness detection.
 *
 * A user with a 5-min-fast laptop clock would otherwise see "expires in 25m"
 * when the server-side truth is 20m, and the 90s staleness banner would
 * mis-fire in either direction. We calibrate against `generated_at_ms` from
 * every successful fetch: the snapshot was generated on the server at that
 * absolute instant, so `offset = serverTs - Date.now()` recorded at
 * response-receive time approximates the skew (absorbing ~one-way network
 * latency, which is tiny compared to user clock drift).
 *
 * Old payloads without `generated_at_ms` (pre-ingest-44caae5) land as `0`
 * offset so behavior degrades to "trust the client clock", matching the
 * pre-feature baseline.
 *
 * See swarm audit 2026-04-18 "Cross-cutting — Time / timezone handling" and
 * Tier 1 #2c.
 */

import { useCallback, useRef, useState } from 'react';

export interface ClockOffset {
  /** Current clock-skew estimate in ms (serverNow - Date.now()). */
  clockOffset: number;
  /**
   * Server-time-adjusted "now" for use anywhere the client currently calls
   * `Date.now()`. Stable reference across renders so consumers can include
   * it in `useEffect` dep arrays without retriggering.
   */
  serverNow: () => number;
  /**
   * Record a fresh server timestamp. Pass the `generated_at_ms` field from
   * the snapshot payload. `null`/`undefined`/`0`/non-finite values reset
   * the offset to `0` (graceful fallback for old payloads).
   */
  recordServerTime: (generatedAtMs: number | null | undefined) => void;
}

export function useClockOffset(): ClockOffset {
  const [clockOffset, setClockOffset] = useState<number>(0);
  // Mirror the latest offset into a ref so `serverNow` stays stable across
  // renders (callers put it in effect deps without causing re-subscription
  // every tick).
  const offsetRef = useRef<number>(0);

  const recordServerTime = useCallback((generatedAtMs: number | null | undefined) => {
    if (generatedAtMs == null || !Number.isFinite(generatedAtMs) || generatedAtMs <= 0) {
      offsetRef.current = 0;
      setClockOffset((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const next = generatedAtMs - Date.now();
    offsetRef.current = next;
    setClockOffset((prev) => (prev === next ? prev : next));
  }, []);

  const serverNow = useCallback((): number => Date.now() + offsetRef.current, []);

  return { clockOffset, serverNow, recordServerTime };
}
