import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { __resetSnapshotStoreForTests, publishSnapshot, useSnapshotState } from './snapshotStore';

describe('snapshotStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
    __resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial state is { generatedAtMs: null, clockOffset: 0 }', () => {
    const { result } = renderHook(() => useSnapshotState());
    expect(result.current).toEqual({ generatedAtMs: null, clockOffset: 0 });
  });

  it('publishSnapshot updates both generatedAtMs and clockOffset', () => {
    const { result } = renderHook(() => useSnapshotState());
    act(() => {
      publishSnapshot(Date.now() + 3_000);
    });
    expect(result.current.generatedAtMs).toBe(Date.now() + 3_000);
    expect(result.current.clockOffset).toBe(3_000);
  });

  it('publishSnapshot(null) preserves last generatedAtMs but zeroes offset', () => {
    const { result } = renderHook(() => useSnapshotState());
    const ts = Date.now() + 4_000;
    act(() => {
      publishSnapshot(ts);
    });
    expect(result.current.clockOffset).toBe(4_000);

    act(() => {
      publishSnapshot(null);
    });
    expect(result.current.generatedAtMs).toBe(ts);
    expect(result.current.clockOffset).toBe(0);
  });

  it('suppresses redundant notifications when state does not change', () => {
    const listener = vi.fn();
    const { result } = renderHook(() => {
      listener();
      return useSnapshotState();
    });

    const ts = Date.now();
    act(() => {
      publishSnapshot(ts);
    });
    const afterFirst = listener.mock.calls.length;

    act(() => {
      publishSnapshot(ts); // same ts; same Date.now(); offset identical
    });
    // Second publish must not cause a re-render because nothing changed.
    expect(listener.mock.calls.length).toBe(afterFirst);
    expect(result.current.generatedAtMs).toBe(ts);
  });
});
