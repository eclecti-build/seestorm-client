import { describe, it, expect } from 'vitest';
import { baseTierFilter, alertLayerFilter } from './alertFilter';

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
