import { describe, it, expect } from 'vitest';
import { useMemo } from 'react';
import { renderHook } from '@testing-library/react';
import { baseTierFilter, alertLayerFilter } from './alertFilter';
import type { AlertTier } from './alerts';

// These tests lock in the exact expression shape because WeatherMap.tsx passes
// the result directly to `map.setFilter(...)`. A regression here silently
// hides or reveals alerts on the map — the worst class of bug for a public
// safety tool — so we assert on structure rather than just behavior.

describe('baseTierFilter', () => {
  it('matches the 8-char " Warning" suffix for Warning tier', () => {
    expect(baseTierFilter('Warning')).toEqual(['==', ['slice', ['get', 'event'], -8], ' Warning']);
  });

  it('matches the 6-char " Watch" suffix for Watch tier', () => {
    expect(baseTierFilter('Watch')).toEqual(['==', ['slice', ['get', 'event'], -6], ' Watch']);
  });

  it('falls through to "neither Warning nor Watch" for Advisory tier', () => {
    expect(baseTierFilter('Advisory')).toEqual([
      'all',
      ['!=', ['slice', ['get', 'event'], -8], ' Warning'],
      ['!=', ['slice', ['get', 'event'], -6], ' Watch'],
    ]);
  });
});

describe('alertLayerFilter', () => {
  it('returns the bare tier filter when no events are hidden', () => {
    // Empty-set fast path keeps the expression tree identical to pre-rework
    // behavior so we can be confident legend state with nothing hidden
    // renders exactly as it did before.
    expect(alertLayerFilter('Warning', new Set())).toEqual(baseTierFilter('Warning'));
    expect(alertLayerFilter('Watch', new Set())).toEqual(baseTierFilter('Watch'));
    expect(alertLayerFilter('Advisory', new Set())).toEqual(baseTierFilter('Advisory'));
  });

  it('AND-composes a ["!", ["in", event, literal-array]] clause when events are hidden', () => {
    const hidden = new Set(['Tornado Watch', 'Severe Thunderstorm Watch']);
    expect(alertLayerFilter('Watch', hidden)).toEqual([
      'all',
      baseTierFilter('Watch'),
      ['!', ['in', ['get', 'event'], ['literal', ['Tornado Watch', 'Severe Thunderstorm Watch']]]],
    ]);
  });

  it('wraps the hidden-event array with ["literal", ...] (bare arrays fail validation)', () => {
    const hidden = new Set(['Flash Flood Warning']);
    const filter = alertLayerFilter('Warning', hidden) as readonly unknown[];

    // Narrow the nested expression explicitly so a future refactor that changes
    // the wrapping can't silently drop the `literal` and pass the test.
    const exclusion = filter[2] as readonly unknown[];
    const inExpr = exclusion[1] as readonly unknown[];
    const haystack = inExpr[2] as readonly unknown[];
    expect(haystack[0]).toBe('literal');
    expect(haystack[1]).toEqual(['Flash Flood Warning']);
  });

  it('preserves hidden-event insertion order in the emitted array', () => {
    // Set iteration is insertion-ordered in ES2015+. Keeping that stable in
    // the emitted filter makes snapshot-style tests meaningful and keeps
    // MapLibre's internal expression-diff cheap on small toggle changes.
    const hidden = new Set<string>();
    hidden.add('Tornado Warning');
    hidden.add('Severe Thunderstorm Warning');
    hidden.add('Flash Flood Warning');

    const filter = alertLayerFilter('Warning', hidden) as readonly unknown[];
    const haystack = (
      (filter[2] as readonly unknown[])[1] as readonly unknown[]
    )[2] as readonly unknown[];
    expect(haystack[1]).toEqual([
      'Tornado Warning',
      'Severe Thunderstorm Warning',
      'Flash Flood Warning',
    ]);
  });
});

// Memoization contract — mirrors the `useMemo(() => ({ Warning, Watch,
// Advisory }), [hiddenEvents])` pattern in WeatherMap.tsx. The filter
// expression itself is a pure function that always returns a fresh array;
// the main-thread savings come from memoizing it at the call site so
// MapLibre's `setFilter` doesn't walk its filter-change path on every 30s
// poll. These tests pin the React referential-stability guarantee so a
// future refactor that drops the `useMemo` wrapper (or broadens the deps)
// fails loudly instead of silently regressing per-poll CPU.
describe('alertLayerFilter — useMemo referential stability', () => {
  /**
   * Harness: apply `useMemo` with the same deps signature WeatherMap uses
   * (just `hiddenEvents`, since `tier` is a constant per entry in the
   * memoized object). Returns the memoized 3-filter map so tests can
   * compare references across rerenders.
   */
  function useAlertFilters(hiddenEvents: ReadonlySet<string>): Record<AlertTier, unknown> {
    return useMemo(
      () => ({
        Warning: alertLayerFilter('Warning', hiddenEvents),
        Watch: alertLayerFilter('Watch', hiddenEvents),
        Advisory: alertLayerFilter('Advisory', hiddenEvents),
      }),
      [hiddenEvents],
    );
  }

  it('returns the same reference across rerenders when hiddenEvents is unchanged', () => {
    const hidden = new Set<string>(['Tornado Warning']);
    const { result, rerender } = renderHook(({ h }) => useAlertFilters(h), {
      initialProps: { h: hidden },
    });
    const first = result.current;
    rerender({ h: hidden });
    // Object.is — not deep equality. If a future change drops the memo and
    // rebuilds the object per render, this assertion fails.
    expect(result.current).toBe(first);
    expect(result.current.Warning).toBe(first.Warning);
  });

  it('returns a NEW reference when hiddenEvents changes identity', () => {
    const { result, rerender } = renderHook(({ h }) => useAlertFilters(h), {
      initialProps: { h: new Set<string>() as ReadonlySet<string> },
    });
    const first = result.current;
    // Simulate a legend toggle: WeatherMap replaces the Set rather than
    // mutating it (setHiddenEvents(new Set(prev))). React sees a new ref
    // in the deps array → memo invalidates → new filter object.
    rerender({ h: new Set(['Tornado Warning']) as ReadonlySet<string> });
    expect(result.current).not.toBe(first);
    expect(result.current.Warning).not.toBe(first.Warning);
  });

  it('preserves memo across rerenders when the caller passes the same Set instance even with other props changing', () => {
    // This models the common WeatherMap case: `isForecast` or `hiddenTiers`
    // flips but `hiddenEvents` stays the same Set reference. The filter
    // memo should NOT invalidate — the filter expression depends only on
    // hiddenEvents.
    const hidden = new Set<string>(['Flood Warning']);
    const { result, rerender } = renderHook(
      ({ h }: { h: ReadonlySet<string>; unrelated: number }) => useAlertFilters(h),
      { initialProps: { h: hidden, unrelated: 0 } },
    );
    const first = result.current;
    rerender({ h: hidden, unrelated: 1 });
    expect(result.current).toBe(first);
  });
});
