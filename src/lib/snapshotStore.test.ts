import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  __resetSnapshotStoreForTests,
  publishLiveFetchFailure,
  publishSnapshot,
  useSnapshotState,
  validateResponseServerNowMs,
} from './snapshotStore';

describe('snapshotStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
    __resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial state is { generatedAtMs: null, clockOffset: 0, consecutiveLiveFailures: 0 }', () => {
    const { result } = renderHook(() => useSnapshotState());
    expect(result.current).toEqual({
      generatedAtMs: null,
      clockOffset: 0,
      consecutiveLiveFailures: 0,
    });
  });

  it('publishSnapshot(live) updates both generatedAtMs and clockOffset', () => {
    const { result } = renderHook(() => useSnapshotState());
    act(() => {
      publishSnapshot(Date.now() + 3_000, { isLive: true });
    });
    expect(result.current.generatedAtMs).toBe(Date.now() + 3_000);
    expect(result.current.clockOffset).toBe(3_000);
  });

  // Fix 1 (Codex pass 2, Critical): a live publish with missing
  // `generated_at_ms` used to preserve the previous timestamp while zeroing
  // the offset — so the banner kept comparing wall-clock time to the stale
  // value and tripped ~90s later even while fresh (but untimestamped)
  // snapshots kept arriving. Now we clear both to `null`/`0` so the banner
  // degrades to "cannot tell".
  it('publishSnapshot(null, live) CLEARS generatedAtMs to null (does not preserve)', () => {
    const { result } = renderHook(() => useSnapshotState());
    const ts = Date.now() + 4_000;
    act(() => {
      publishSnapshot(ts, { isLive: true });
    });
    expect(result.current.generatedAtMs).toBe(ts);
    expect(result.current.clockOffset).toBe(4_000);

    act(() => {
      publishSnapshot(null, { isLive: true });
    });
    // Key assertion: the stale timestamp is GONE, not preserved.
    expect(result.current.generatedAtMs).toBeNull();
    expect(result.current.clockOffset).toBe(0);
  });

  // Fix 2 (Codex pass 2, Critical): historical fetches share the same
  // snapshot payload shape (and `generated_at_ms` field) as live fetches.
  // If they update the store the staleness banner trips and `serverNow()`
  // gets poisoned. `isLive: false` must be a pure no-op.
  it('publishSnapshot with { isLive: false } does NOT modify store state', () => {
    const { result } = renderHook(() => useSnapshotState());
    const liveTs = Date.now() + 2_000;
    act(() => {
      publishSnapshot(liveTs, { isLive: true });
    });
    expect(result.current.generatedAtMs).toBe(liveTs);
    expect(result.current.clockOffset).toBe(2_000);

    // Historical scrub publishes an intentionally old ts. Store must stay
    // pinned to the LIVE values from the prior publish.
    const historicalTs = liveTs - 10 * 60_000; // 10 minutes earlier
    act(() => {
      publishSnapshot(historicalTs, { isLive: false });
    });
    expect(result.current.generatedAtMs).toBe(liveTs);
    expect(result.current.clockOffset).toBe(2_000);

    // Even a `null` historical publish must not clear prior live state.
    act(() => {
      publishSnapshot(null, { isLive: false });
    });
    expect(result.current.generatedAtMs).toBe(liveTs);
    expect(result.current.clockOffset).toBe(2_000);
  });

  it('suppresses redundant notifications when state does not change', () => {
    const listener = vi.fn();
    const { result } = renderHook(() => {
      listener();
      return useSnapshotState();
    });

    const ts = Date.now();
    act(() => {
      publishSnapshot(ts, { isLive: true });
    });
    const afterFirst = listener.mock.calls.length;

    act(() => {
      publishSnapshot(ts, { isLive: true }); // same ts; same Date.now(); offset identical
    });
    // Second publish must not cause a re-render because nothing changed.
    expect(listener.mock.calls.length).toBe(afterFirst);
    expect(result.current.generatedAtMs).toBe(ts);
  });

  it('initial state includes consecutiveLiveFailures: 0', () => {
    const { result } = renderHook(() => useSnapshotState());
    expect(result.current.consecutiveLiveFailures).toBe(0);
  });

  it('publishLiveFetchFailure increments consecutiveLiveFailures without touching generatedAtMs/clockOffset', () => {
    const { result } = renderHook(() => useSnapshotState());
    act(() => {
      publishLiveFetchFailure();
      publishLiveFetchFailure();
    });
    expect(result.current.consecutiveLiveFailures).toBe(2);
    expect(result.current.generatedAtMs).toBeNull();
    expect(result.current.clockOffset).toBe(0);
  });

  it('a successful live publishSnapshot resets consecutiveLiveFailures to 0', () => {
    const { result } = renderHook(() => useSnapshotState());
    act(() => {
      publishLiveFetchFailure();
      publishLiveFetchFailure();
    });
    expect(result.current.consecutiveLiveFailures).toBe(2);
    act(() => {
      publishSnapshot(Date.now(), { isLive: true });
    });
    expect(result.current.consecutiveLiveFailures).toBe(0);
  });

  it('a live publishSnapshot with missing generatedAtMs still resets consecutiveLiveFailures (a successful HTTP round-trip is not a fetch failure)', () => {
    const { result } = renderHook(() => useSnapshotState());
    act(() => {
      publishLiveFetchFailure();
    });
    act(() => {
      publishSnapshot(null, { isLive: true });
    });
    expect(result.current.consecutiveLiveFailures).toBe(0);
  });

  // REVIEW AMENDMENT (2026-07-08 Tier 1 plan, Task 1): publishSnapshot's
  // "avoid spurious notifications when nothing changed" dedup guard
  // originally compared only generatedAtMs/clockOffset. If a publish
  // republishes the SAME generatedAtMs (and therefore the same
  // clockOffset) as currentState — plausible any time two consecutive live
  // fetches happen to carry an identical generated_at_ms, e.g. a
  // slow-moving quiet period, or simply the very next successful fetch
  // after a run of failures resolves to a value the store already holds —
  // a version of this fix that folds the counter reset into `next` but
  // dedups on generatedAtMs/clockOffset alone would hit the early `return`
  // before `currentState = next` ever runs, silently discarding the reset
  // and leaving consecutiveLiveFailures stuck at its pre-success value
  // forever (AlertsPanel's degraded notice would then never clear). This
  // test pins that the reset survives that exact case.
  it('resets consecutiveLiveFailures on a successful publish even when generatedAtMs/clockOffset are unchanged from the current state', () => {
    const { result } = renderHook(() => useSnapshotState());
    const ts = Date.now() + 5_000;
    act(() => {
      publishSnapshot(ts, { isLive: true });
    });
    expect(result.current.generatedAtMs).toBe(ts);
    expect(result.current.consecutiveLiveFailures).toBe(0);

    act(() => {
      publishLiveFetchFailure();
      publishLiveFetchFailure();
    });
    expect(result.current.consecutiveLiveFailures).toBe(2);

    // Same ts as the first publish above → same generatedAtMs AND (under
    // vi.useFakeTimers with a frozen system time) the same clockOffset.
    // The dedup guard must still let the failure-counter reset through.
    act(() => {
      publishSnapshot(ts, { isLive: true });
    });
    expect(result.current.generatedAtMs).toBe(ts);
    expect(result.current.consecutiveLiveFailures).toBe(0);
  });

  it('prefers responseServerNowMs over generatedAtMs for clockOffset when both are present', () => {
    const { result } = renderHook(() => useSnapshotState());
    const generatedAtMs = Date.now() - 50_000; // stale snapshot-generation ts (cache hit)
    const responseServerNowMs = Date.now() + 1_000; // true server-now from Date+Age
    act(() => {
      publishSnapshot(generatedAtMs, { isLive: true, responseServerNowMs });
    });
    expect(result.current.generatedAtMs).toBe(generatedAtMs);
    expect(result.current.clockOffset).toBe(1_000);
  });

  it('falls back to the generatedAtMs-derived offset when responseServerNowMs is absent', () => {
    const { result } = renderHook(() => useSnapshotState());
    const ts = Date.now() + 3_000;
    act(() => {
      publishSnapshot(ts, { isLive: true });
    });
    expect(result.current.clockOffset).toBe(3_000);
  });

  it('falls back to the generatedAtMs-derived offset when responseServerNowMs is null', () => {
    const { result } = renderHook(() => useSnapshotState());
    const ts = Date.now() + 3_000;
    act(() => {
      publishSnapshot(ts, { isLive: true, responseServerNowMs: null });
    });
    expect(result.current.clockOffset).toBe(3_000);
  });

  it('ignores responseServerNowMs when generatedAtMs is null/invalid (still clears both fields)', () => {
    const { result } = renderHook(() => useSnapshotState());
    act(() => {
      publishSnapshot(null, { isLive: true, responseServerNowMs: Date.now() });
    });
    expect(result.current.generatedAtMs).toBeNull();
    expect(result.current.clockOffset).toBe(0);
  });

  describe('validateResponseServerNowMs', () => {
    it('accepts a candidate within the trust threshold', () => {
      const now = Date.now();
      expect(validateResponseServerNowMs(now + 1_000, now)).toBe(now + 1_000);
    });

    it('accepts a candidate exactly at the trust threshold boundary', () => {
      const now = Date.now();
      expect(validateResponseServerNowMs(now + 5 * 60_000, now)).toBe(now + 5 * 60_000);
    });

    it('rejects (returns null) a candidate 10 minutes off from local time, and logs a console.warn', () => {
      const now = Date.now();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tenMinutesOff = now + 10 * 60_000;
      expect(validateResponseServerNowMs(tenMinutesOff, now)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/Discarding Date\/Age clock calibration/);
      warnSpy.mockRestore();
    });

    it('rejects a candidate that is implausibly far in the PAST too (drift is |diff|, not signed)', () => {
      const now = Date.now();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(validateResponseServerNowMs(now - 10 * 60_000, now)).toBeNull();
      warnSpy.mockRestore();
    });

    it('passes null through unchanged (no Date header parsed)', () => {
      expect(validateResponseServerNowMs(null)).toBeNull();
    });
  });
});
