import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { POLL_INTERVAL_MS } from './constants';
import { liveRadarTickOverdue, useLiveRadarTick } from './useLiveRadarTick';

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useLiveRadarTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not tick on entry', () => {
    const { result } = renderHook(() => useLiveRadarTick(true));
    expect(result.current).toBe(0);
    advance(POLL_INTERVAL_MS - 1);
    expect(result.current).toBe(0);
  });

  it('ticks once per interval', () => {
    const { result } = renderHook(() => useLiveRadarTick(true));
    advance(POLL_INTERVAL_MS);
    expect(result.current).toBe(1);
    advance(POLL_INTERVAL_MS * 2);
    expect(result.current).toBe(3);
  });

  it('never ticks while disabled', () => {
    const { result } = renderHook(() => useLiveRadarTick(false));
    advance(POLL_INTERVAL_MS * 3);
    vi.setSystemTime(Date.now() + POLL_INTERVAL_MS * 10);
    setVisibility('visible');
    expect(result.current).toBe(0);
  });

  it('starts the first interval when enabled, not on mount', () => {
    const { result, rerender } = renderHook(({ on }) => useLiveRadarTick(on), {
      initialProps: { on: false },
    });
    advance(POLL_INTERVAL_MS / 2);
    rerender({ on: true });
    advance(POLL_INTERVAL_MS - 1);
    expect(result.current).toBe(0);
    advance(1);
    expect(result.current).toBe(1);
  });

  it('does not tick on becoming visible when no tick is overdue', () => {
    const { result } = renderHook(() => useLiveRadarTick(true));
    advance(POLL_INTERVAL_MS - 1);
    setVisibility('hidden');
    setVisibility('visible');
    expect(result.current).toBe(0);
    // The interval is untouched: its tick still lands on schedule.
    advance(1);
    expect(result.current).toBe(1);
  });

  it('ticks on becoming visible when a tick is overdue, then restarts the interval', () => {
    const { result } = renderHook(() => useLiveRadarTick(true));
    setVisibility('hidden');
    // A throttled hidden tab: the clock moves on but the interval never fires.
    vi.setSystemTime(Date.now() + POLL_INTERVAL_MS * 3);
    setVisibility('visible');
    expect(result.current).toBe(1);
    advance(POLL_INTERVAL_MS - 1);
    expect(result.current).toBe(1);
    advance(1);
    expect(result.current).toBe(2);
  });

  it('ignores a visibilitychange to hidden even when overdue', () => {
    const { result } = renderHook(() => useLiveRadarTick(true));
    vi.setSystemTime(Date.now() + POLL_INTERVAL_MS * 3);
    setVisibility('hidden');
    expect(result.current).toBe(0);
  });

  it('stops ticking when disabled and on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { result, rerender, unmount } = renderHook(({ on }) => useLiveRadarTick(on), {
      initialProps: { on: true },
    });
    advance(POLL_INTERVAL_MS);
    rerender({ on: false });
    advance(POLL_INTERVAL_MS * 3);
    expect(result.current).toBe(1);
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    rerender({ on: true });
    removeSpy.mockClear();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('liveRadarTickOverdue', () => {
  it('leaves a tick still within the interval to the interval', () => {
    expect(liveRadarTickOverdue(0, POLL_INTERVAL_MS - 1)).toBe(false);
  });

  it('fires once a full interval has passed since the last tick', () => {
    expect(liveRadarTickOverdue(0, POLL_INTERVAL_MS)).toBe(true);
    expect(liveRadarTickOverdue(0, 10 * POLL_INTERVAL_MS)).toBe(true);
  });
});
