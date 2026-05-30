import { describe, it, expect } from 'vitest';
import { COVERAGE, STATE_NAMES } from './coverage';
import {
  REGIONS,
  OFFSHORE,
  STATE_TO_REGION,
  NAME_TO_CODE,
  regionForCode,
  type RegionId,
} from './regions';

describe('regions — coverage invariants', () => {
  it('every supported code is reachable via exactly one region or the offshore group', () => {
    // The whole point of the drill-down redesign: splitting 55 codes into
    // regions must not strand any jurisdiction. Each COVERAGE code appears
    // once across (all region members ∪ offshore), no more, no less.
    const counts = new Map<string, number>();
    for (const region of REGIONS) {
      for (const code of region.members) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    for (const code of OFFSHORE) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }

    for (const code of COVERAGE) {
      expect(counts.get(code), `${code} should be reachable exactly once`).toBe(1);
    }
    // Nothing outside COVERAGE leaked in.
    for (const code of counts.keys()) {
      expect(COVERAGE).toContain(code);
    }
  });

  it('regions are disjoint — no state lives in two regions', () => {
    const seen = new Set<string>();
    for (const region of REGIONS) {
      for (const code of region.members) {
        expect(seen.has(code), `${code} is duplicated across regions`).toBe(false);
        seen.add(code);
      }
    }
  });

  it('groups the 49 contiguous jurisdictions (48 states + DC) across regions', () => {
    const total = REGIONS.reduce((n, r) => n + r.members.length, 0);
    expect(total).toBe(49);
  });

  it('every region has a label and at least one member', () => {
    for (const region of REGIONS) {
      expect(region.label.length).toBeGreaterThan(0);
      expect(region.members.length).toBeGreaterThan(0);
    }
  });

  it('keeps the Great Lakes home turf together in the midwest region', () => {
    const midwest = REGIONS.find((r) => r.id === 'midwest');
    expect(midwest).toBeDefined();
    expect(midwest?.members).toContain('WI');
    expect(midwest?.members).toContain('MI');
    expect(midwest?.members).toContain('MN');
  });

  it('routes Alaska, Hawaii and the territories through the offshore group', () => {
    for (const code of ['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP'] as const) {
      expect(OFFSHORE).toContain(code);
    }
  });
});

describe('regions — lookups', () => {
  it('STATE_TO_REGION resolves a contiguous code to its region id', () => {
    expect(STATE_TO_REGION.WI).toBe('midwest');
    expect(STATE_TO_REGION.CA).toBe('west');
    expect(STATE_TO_REGION.ME).toBe('newengland');
  });

  it('regionForCode returns the region for a member and null for offshore', () => {
    const wi = regionForCode('WI');
    expect(wi?.id).toBe<RegionId>('midwest');
    expect(regionForCode('AK')).toBeNull();
    expect(regionForCode('ZZ')).toBeNull();
  });

  it('NAME_TO_CODE inverts STATE_NAMES so GeoJSON feature names resolve to codes', () => {
    for (const [code, name] of Object.entries(STATE_NAMES)) {
      expect(NAME_TO_CODE[name]).toBe(code);
    }
  });
});
