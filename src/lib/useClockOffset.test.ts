/**
 * Clock-skew calibration tests (swarm audit 2026-04-18, Tier 1 #2c +
 * Cross-cutting — Time / timezone handling).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useClockOffset } from './useClockOffset';

describe('useClockOffset', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns offset 0 and serverNow == Date.now() before any fetch has landed', () => {
    const { result } = renderHook(() => useClockOffset());
    expect(result.current.clockOffset).toBe(0);
    expect(result.current.serverNow()).toBe(Date.now());
  });

  it('computes clockOffset = generated_at_ms - Date.now() on recordServerTime', () => {
    const { result } = renderHook(() => useClockOffset());
    const now = Date.now();
    // Pretend the server is 4 seconds ahead of our clock.
    const serverTs = now + 4_000;

    act(() => {
      result.current.recordServerTime(serverTs);
    });

    expect(result.current.clockOffset).toBe(4_000);
    // serverNow() == Date.now() + offset; with no wall-clock progression
    // between record and read, that equals the recorded serverTs.
    expect(result.current.serverNow()).toBe(now + 4_000);
  });

  it('is stable across calls — serverNow() is referentially consistent', () => {
    const { result, rerender } = renderHook(() => useClockOffset());
    const firstServerNow = result.current.serverNow;
    rerender();
    expect(result.current.serverNow).toBe(firstServerNow);
  });

  it('falls back to clockOffset = 0 when generated_at_ms is missing (old payload)', () => {
    const { result } = renderHook(() => useClockOffset());

    // First prime a non-zero offset so we can observe the reset.
    act(() => {
      result.current.recordServerTime(Date.now() + 10_000);
    });
    expect(result.current.clockOffset).toBe(10_000);

    // Old payload: field missing.
    act(() => {
      result.current.recordServerTime(undefined);
    });
    expect(result.current.clockOffset).toBe(0);
    expect(result.current.serverNow()).toBe(Date.now());
  });

  it('falls back to 0 for null, 0, NaN, or negative server timestamps', () => {
    const { result } = renderHook(() => useClockOffset());
    for (const bad of [null, 0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      act(() => {
        result.current.recordServerTime(bad as number | null);
      });
      expect(result.current.clockOffset).toBe(0);
    }
  });

  it('tracks a negative skew (user clock ahead of server)', () => {
    const { result } = renderHook(() => useClockOffset());
    const now = Date.now();
    act(() => {
      result.current.recordServerTime(now - 5_000);
    });
    expect(result.current.clockOffset).toBe(-5_000);
    expect(result.current.serverNow()).toBe(now - 5_000);
  });
});
