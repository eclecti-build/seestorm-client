/**
 * Regression coverage for the poll-effect identity-churn bug (Tier 2
 * resilience hardening, 2026-07-08). See WeatherMap.tsx's `fetchHistory`
 * useCallback (pre-fix deps=[sliderValue]) and the live-poll useEffect
 * (deps=[mapReady, isLive, fetchLive, fetchHistory]).
 *
 * WeatherMap itself doesn't render in jsdom (MapLibre), so this suite
 * pins the *pattern* via a fixture mirroring the production shapes
 * exactly, following the precedent in WeatherMap.refreshLoop.test.tsx.
 * One fixture, two modes (`buggyFetchHistory` prop), so this single file
 * proves both the regression (red, buggy=true) and the fix (green,
 * buggy=false).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ChurnFixtureProps {
  onFetchLiveStart: () => void;
  onFetchLiveAbort: () => void;
  buggyFetchHistory: boolean;
}

function ChurnFixture({
  onFetchLiveStart,
  onFetchLiveAbort,
  buggyFetchHistory,
}: ChurnFixtureProps) {
  const [sliderValue, setSliderValue] = useState(0);
  const [, setHistory] = useState<string[]>([]);
  const historyGenerationRef = useRef(0);
  const appliedHistoryGenerationRef = useRef(-1);
  const sliderValueRef = useRef(sliderValue);
  useEffect(() => {
    sliderValueRef.current = sliderValue;
  }, [sliderValue]);

  // Mirrors WeatherMap's fetchLive: stable identity, resolves after a
  // tick, reports whether it got aborted mid-flight (a HEALTHY in-flight
  // fetch getting cancelled by effect teardown, as opposed to a
  // legitimate unmount/transition abort).
  const fetchLive = useCallback(
    async (signal?: AbortSignal) => {
      onFetchLiveStart();
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 20);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (aborted) onFetchLiveAbort();
    },
    [onFetchLiveAbort, onFetchLiveStart],
  );

  // BUGGY shape: mirrors pre-fix production (deps=[sliderValue]).
  const fetchHistoryBuggy = useCallback(async () => {
    setHistory((prev) => {
      if (appliedHistoryGenerationRef.current === historyGenerationRef.current) return prev;
      appliedHistoryGenerationRef.current = historyGenerationRef.current;
      const next = [...prev, `snap-${historyGenerationRef.current}`];
      if (sliderValue === prev.length) setSliderValue(next.length);
      return next;
    });
  }, [sliderValue]);

  // FIXED shape: ref-based, stable deps=[].
  const fetchHistoryFixed = useCallback(async () => {
    setHistory((prev) => {
      if (appliedHistoryGenerationRef.current === historyGenerationRef.current) return prev;
      appliedHistoryGenerationRef.current = historyGenerationRef.current;
      const next = [...prev, `snap-${historyGenerationRef.current}`];
      if (sliderValueRef.current === prev.length) setSliderValue(next.length);
      return next;
    });
  }, []);

  const fetchHistory = buggyFetchHistory ? fetchHistoryBuggy : fetchHistoryFixed;

  // Mirrors WeatherMap's live-poll effect exactly: one AbortController
  // per effect run, deps include both fetch callbacks.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void fetchLive(signal);
    void fetchHistory();
    const interval = setInterval(() => {
      void fetchLive(signal);
      historyGenerationRef.current += 1;
      void fetchHistory();
    }, 30_000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [fetchLive, fetchHistory]);

  return null;
}

describe('WeatherMap poll-effect identity churn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('BUGGY fetchHistory([sliderValue]) tears the effect down and aborts a healthy in-flight fetchLive', async () => {
    const onFetchLiveStart = vi.fn();
    const onFetchLiveAbort = vi.fn();
    render(
      <ChurnFixture
        onFetchLiveStart={onFetchLiveStart}
        onFetchLiveAbort={onFetchLiveAbort}
        buggyFetchHistory={true}
      />,
    );

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }

    expect(onFetchLiveAbort).toHaveBeenCalled();
  });

  it('FIXED fetchHistory (ref-based, stable deps) keeps one long-lived effect and never aborts a healthy in-flight fetchLive', async () => {
    const onFetchLiveStart = vi.fn();
    const onFetchLiveAbort = vi.fn();
    render(
      <ChurnFixture
        onFetchLiveStart={onFetchLiveStart}
        onFetchLiveAbort={onFetchLiveAbort}
        buggyFetchHistory={false}
      />,
    );

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }

    // One fetchLive call per cycle (mount + 3 interval ticks = 4), never
    // doubled by a teardown/remount, and never aborted mid-flight.
    expect(onFetchLiveStart).toHaveBeenCalledTimes(4);
    expect(onFetchLiveAbort).not.toHaveBeenCalled();
  });
});
