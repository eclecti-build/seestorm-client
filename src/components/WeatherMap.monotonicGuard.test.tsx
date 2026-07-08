/**
 * Regression coverage for the missing response-sequencing guard on live
 * snapshot fetches (Tier 2 resilience hardening, 2026-07-08). Two
 * concurrent fetchLive calls (e.g. the 30s interval tick and an
 * overlapping visibilitychange-triggered refetch) can resolve
 * out of order. Before this fix, whichever resolves LAST wins via
 * startTransition (WeatherMap.tsx:582-590), even if its payload's
 * `generated_at_ms` is OLDER than the currently-rendered snapshot.
 * Mirrors the Fixture pattern from WeatherMap.startTransition.test.tsx.
 *
 * Also covers the future-timestamp sanity bound (review amendment): the
 * "older than rendered" guard alone has no UPPER bound, so a single
 * future-dated bad snapshot would set renderedGeneratedAtMsRef far ahead
 * of real time and permanently poison it — every subsequent correctly-
 * timed snapshot would look "older than rendered" and get silently
 * dropped forever, freezing the map for the rest of the session. The
 * fix rejects (with console.warn) anything more than 5 minutes ahead of
 * now WITHOUT updating the ref, mirroring the existing non-finite/<=0
 * guard idiom in useClockOffset.recordServerTime (src/lib/useClockOffset.ts)
 * — reject-and-bail without mutating state on an out-of-bounds input.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { startTransition, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Snapshot = { alerts: string[]; generatedAtMs: number };

// Mirrors the production MAX_FUTURE_SNAPSHOT_MS constant added to
// WeatherMap.tsx (see the "Implement" step below).
const MAX_FUTURE_SNAPSHOT_MS = 5 * 60 * 1000;

interface FixtureProps {
  onApplied: (alerts: string[]) => void;
  triggerRef: { current: ((snap: Snapshot) => Promise<void>) | null };
  // Injectable clock so the future-bound test is deterministic. This models
  // production's serverNow() calibrated clock source; the default matches
  // uncalibrated sessions, where serverNow() has offset 0 and equals Date.now().
  now?: () => number;
  onRejected?: () => void;
}

// Mirrors WeatherMap's fetchLive apply path PLUS the monotonic guard
// (drop older-than-rendered) AND the future-timestamp sanity bound
// (drop anything more than MAX_FUTURE_SNAPSHOT_MS ahead of now) — both
// reject WITHOUT touching renderedGeneratedAtMsRef, so neither a stale
// nor a bogus-future payload can poison state for subsequent snapshots.
function Fixture({
  onApplied,
  triggerRef,
  now = () => Date.now(),
  onRejected,
}: FixtureProps): ReactNode {
  const [alerts, setAlerts] = useState<string[]>([]);
  const renderedGeneratedAtMsRef = useRef<number | null>(null);

  const apply = useCallback(
    async (snap: Snapshot) => {
      if (
        renderedGeneratedAtMsRef.current !== null &&
        snap.generatedAtMs < renderedGeneratedAtMsRef.current
      ) {
        return; // stale — drop silently, exactly like the production guard
      }
      if (snap.generatedAtMs > now() + MAX_FUTURE_SNAPSHOT_MS) {
        // Future-dated bad snapshot (clock skew or bad upstream data) —
        // drop WITHOUT updating the ref, so it can't poison subsequent,
        // correctly-timed snapshots into looking "older than rendered."
        console.warn(
          `Rejected snapshot with generated_at_ms too far in the future (${snap.generatedAtMs}), possible clock skew or bad data`,
        );
        onRejected?.();
        return;
      }
      renderedGeneratedAtMsRef.current = snap.generatedAtMs;
      startTransition(() => {
        setAlerts(snap.alerts);
        onApplied(snap.alerts);
      });
    },
    [onApplied, now, onRejected],
  );

  useEffect(() => {
    triggerRef.current = apply;
    return () => {
      triggerRef.current = null;
    };
  }, [apply, triggerRef]);

  return <span data-testid="count">{alerts.length}</span>;
}

describe('WeatherMap live-fetch monotonic guard', () => {
  it('drops an older response that resolves after a newer one', async () => {
    const onApplied = vi.fn();
    const triggerRef: { current: ((snap: Snapshot) => Promise<void>) | null } = { current: null };
    render(<Fixture onApplied={onApplied} triggerRef={triggerRef} />);

    const newer: Snapshot = { alerts: ['A', 'B'], generatedAtMs: 2_000 };
    const older: Snapshot = { alerts: ['A'], generatedAtMs: 1_000 };

    // Newer resolves FIRST (e.g. the interval tick's fetch), older
    // resolves SECOND (e.g. a slow overlapping visibilitychange refetch
    // that started earlier but took longer) — the out-of-order case the
    // guard exists for.
    await act(async () => {
      await triggerRef.current!(newer);
      await triggerRef.current!(older);
    });

    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(newer.alerts);
  });

  it('applies an in-order sequence of strictly increasing timestamps', async () => {
    const onApplied = vi.fn();
    const triggerRef: { current: ((snap: Snapshot) => Promise<void>) | null } = { current: null };
    render(<Fixture onApplied={onApplied} triggerRef={triggerRef} />);

    await act(async () => {
      await triggerRef.current!({ alerts: ['A'], generatedAtMs: 1_000 });
      await triggerRef.current!({ alerts: ['A', 'B'], generatedAtMs: 2_000 });
    });

    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(onApplied).toHaveBeenLastCalledWith(['A', 'B']);
  });

  it('rejects a snapshot more than 5 minutes in the future and warns, without poisoning the ref for later snapshots (review amendment)', async () => {
    const onApplied = vi.fn();
    const onRejected = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const triggerRef: { current: ((snap: Snapshot) => Promise<void>) | null } = { current: null };
    const fixedNow = 1_000_000;
    render(
      <Fixture
        onApplied={onApplied}
        triggerRef={triggerRef}
        now={() => fixedNow}
        onRejected={onRejected}
      />,
    );

    const farFuture: Snapshot = { alerts: ['BAD'], generatedAtMs: fixedNow + 10 * 60 * 1000 }; // 10min ahead
    const normal: Snapshot = { alerts: ['A'], generatedAtMs: fixedNow + 1_000 };

    await act(async () => {
      await triggerRef.current!(farFuture);
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A subsequent NORMAL snapshot must still apply — proves the
    // rejected future snapshot did NOT poison renderedGeneratedAtMsRef
    // (if it had, this normal snapshot would look "older than rendered"
    // and get silently dropped by the OTHER guard instead).
    await act(async () => {
      await triggerRef.current!(normal);
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(normal.alerts);
    expect(onRejected).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('rejects and reports a future snapshot when the clock source is 10 minutes behind the payload', async () => {
    const onApplied = vi.fn();
    const onRejected = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const triggerRef: { current: ((snap: Snapshot) => Promise<void>) | null } = { current: null };
    const snapshotNow = 1_000_000;
    const slowClockNow = snapshotNow - 10 * 60 * 1000;
    render(
      <Fixture
        onApplied={onApplied}
        triggerRef={triggerRef}
        now={() => slowClockNow}
        onRejected={onRejected}
      />,
    );

    await act(async () => {
      await triggerRef.current!({ alerts: ['A'], generatedAtMs: snapshotNow });
    });

    expect(onApplied).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('accepts a snapshot within the future-tolerance window (ordinary clock skew, not a bad snapshot)', async () => {
    const onApplied = vi.fn();
    const triggerRef: { current: ((snap: Snapshot) => Promise<void>) | null } = { current: null };
    const fixedNow = 1_000_000;
    render(<Fixture onApplied={onApplied} triggerRef={triggerRef} now={() => fixedNow} />);

    const withinTolerance: Snapshot = { alerts: ['A'], generatedAtMs: fixedNow + 4 * 60 * 1000 }; // 4min ahead, under the 5min bound
    await act(async () => {
      await triggerRef.current!(withinTolerance);
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
