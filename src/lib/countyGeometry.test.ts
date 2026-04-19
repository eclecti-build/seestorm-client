import { describe, it, expect } from 'vitest';
import {
  buildCountyLookup,
  parseCountyNamesFromAreaDesc,
  synthesizeGeometryFromAreaDesc,
} from './countyGeometry';
import { USPS_TO_FIPS } from './stateFips';

function countyFC(
  entries: Array<{
    name: string;
    state?: string; // USPS code; defaults to 'WI' for backward-compat with existing fixtures
    poly?: GeoJSON.Polygon;
    multi?: GeoJSON.MultiPolygon;
  }>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: entries.map((e) => ({
      type: 'Feature',
      properties: {
        NAME: e.name,
        STATE: USPS_TO_FIPS[(e.state ?? 'WI').toUpperCase()] ?? '55',
      },
      geometry: e.multi ?? e.poly ?? null,
    })) as GeoJSON.Feature[],
  };
}

const DANE_POLY: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-89.5, 43.0],
      [-89.4, 43.0],
      [-89.4, 43.1],
      [-89.5, 43.1],
      [-89.5, 43.0],
    ],
  ],
};

const ROCK_MULTI: GeoJSON.MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-89.2, 42.5],
        [-89.1, 42.5],
        [-89.1, 42.6],
        [-89.2, 42.6],
        [-89.2, 42.5],
      ],
    ],
  ],
};

// A second Washington polygon in IA, distinct from any WI polygon. Used to
// prove the lookup no longer silently overwrites same-named counties across
// states.
const WASHINGTON_IA_POLY: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-91.8, 41.2],
      [-91.7, 41.2],
      [-91.7, 41.3],
      [-91.8, 41.3],
      [-91.8, 41.2],
    ],
  ],
};

const WASHINGTON_WI_POLY: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-88.3, 43.4],
      [-88.2, 43.4],
      [-88.2, 43.5],
      [-88.3, 43.5],
      [-88.3, 43.4],
    ],
  ],
};

describe('parseCountyNamesFromAreaDesc', () => {
  it('extracts a single county', () => {
    expect(parseCountyNamesFromAreaDesc('Dane, WI')).toEqual([{ name: 'Dane', state: 'WI' }]);
  });

  it('splits on semicolons and strips the state suffix on each segment', () => {
    expect(parseCountyNamesFromAreaDesc('Dane, WI; Rock, WI; Green, WI')).toEqual([
      { name: 'Dane', state: 'WI' },
      { name: 'Rock', state: 'WI' },
      { name: 'Green', state: 'WI' },
    ]);
  });

  it('preserves multi-word county names', () => {
    expect(parseCountyNamesFromAreaDesc('Fond du Lac, WI; Eau Claire, WI')).toEqual([
      { name: 'Fond du Lac', state: 'WI' },
      { name: 'Eau Claire', state: 'WI' },
    ]);
  });

  it('defaults no-state-suffix segments to the first allowed state', () => {
    expect(parseCountyNamesFromAreaDesc('Dane; Rock')).toEqual([
      { name: 'Dane', state: 'WI' },
      { name: 'Rock', state: 'WI' },
    ]);
    expect(parseCountyNamesFromAreaDesc('Dane; Rock', { allowedStates: ['IL', 'WI'] })).toEqual([
      { name: 'Dane', state: 'IL' },
      { name: 'Rock', state: 'IL' },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(parseCountyNamesFromAreaDesc('')).toEqual([]);
  });

  it('drops out-of-state segments by default (WI-only scope)', () => {
    // Cross-state Tornado Watch: Winnebago exists in both IL and WI.
    // Without filtering we'd hydrate WI's Winnebago twice (once per segment),
    // producing a wrong-state polygon alongside the correct one.
    expect(parseCountyNamesFromAreaDesc('Winnebago, IL; Boone, IL; Winnebago, WI')).toEqual([
      { name: 'Winnebago', state: 'WI' },
    ]);
  });

  it('honors custom allowedStates and preserves each segment\u2019s state', () => {
    expect(
      parseCountyNamesFromAreaDesc('Dane, WI; Cook, IL', { allowedStates: ['WI', 'IL'] }),
    ).toEqual([
      { name: 'Dane', state: 'WI' },
      { name: 'Cook', state: 'IL' },
    ]);
    expect(parseCountyNamesFromAreaDesc('Dane, WI; Cook, IL', { allowedStates: ['IL'] })).toEqual([
      { name: 'Cook', state: 'IL' },
    ]);
  });
});

describe('buildCountyLookup', () => {
  it('looks up by case-insensitive name with explicit state', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Dane', state: 'WI', poly: DANE_POLY }]));
    expect(lookup('Dane', 'WI')).not.toBeNull();
    expect(lookup('dane', 'WI')).not.toBeNull();
    expect(lookup('DANE', 'wi')).not.toBeNull();
  });

  it('promotes Polygon features to MultiPolygon', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Dane', state: 'WI', poly: DANE_POLY }]));
    const hit = lookup('Dane', 'WI');
    expect(hit?.type).toBe('MultiPolygon');
    expect(hit?.coordinates).toEqual([DANE_POLY.coordinates]);
  });

  it('keeps MultiPolygon features as-is', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Rock', state: 'WI', multi: ROCK_MULTI }]));
    expect(lookup('Rock', 'WI')).toEqual(ROCK_MULTI);
  });

  it('returns null for unknown county or wrong state', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Dane', state: 'WI', poly: DANE_POLY }]));
    expect(lookup('Milwaukee', 'WI')).toBeNull();
    expect(lookup('Dane', 'IL')).toBeNull();
  });

  it('keeps same-named counties in different states distinct (regression)', () => {
    // Before the state-qualified fix, `Washington, IA` and `Washington, WI`
    // collided in a single name-keyed map and the later-loaded polygon silently
    // overwrote the earlier one. Adding Iowa to coverage made this latent bug
    // hit many more counties (Washington, Lee, Polk, Madison, Monroe, …). This
    // test pins the fix: both polygons must round-trip through the lookup
    // under their own state code.
    const lookup = buildCountyLookup(
      countyFC([
        { name: 'Washington', state: 'WI', poly: WASHINGTON_WI_POLY },
        { name: 'Washington', state: 'IA', poly: WASHINGTON_IA_POLY },
      ]),
    );
    expect(lookup('Washington', 'WI')?.coordinates).toEqual([WASHINGTON_WI_POLY.coordinates]);
    expect(lookup('Washington', 'IA')?.coordinates).toEqual([WASHINGTON_IA_POLY.coordinates]);
  });

  it('skips features with null geometry, missing name, or missing/unknown state', () => {
    // Cast through unknown because the GeoJSON type rejects `null` geometry,
    // but real FeatureCollections in the wild sometimes contain it and the
    // lookup builder must not crash on that case. Also validates that
    // STATE-less or out-of-scope-state features are dropped rather than
    // bucketed under a default (which would reintroduce the collision bug).
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { NAME: 'Dane', STATE: '55' }, geometry: null },
        { type: 'Feature', properties: { STATE: '55' }, geometry: DANE_POLY },
        { type: 'Feature', properties: { NAME: 'Dane' }, geometry: DANE_POLY }, // no STATE
        { type: 'Feature', properties: { NAME: 'Dane', STATE: '06' }, geometry: DANE_POLY }, // CA, out of scope
      ],
    } as unknown as GeoJSON.FeatureCollection;
    const lookup = buildCountyLookup(fc);
    expect(lookup('Dane', 'WI')).toBeNull();
    expect(lookup('Dane', 'CA')).toBeNull();
  });
});

describe('synthesizeGeometryFromAreaDesc', () => {
  const lookup = buildCountyLookup(
    countyFC([
      { name: 'Dane', state: 'WI', poly: DANE_POLY },
      { name: 'Rock', state: 'WI', multi: ROCK_MULTI },
      { name: 'Washington', state: 'WI', poly: WASHINGTON_WI_POLY },
      { name: 'Washington', state: 'IA', poly: WASHINGTON_IA_POLY },
    ]),
  );

  it('unions every matching county into one MultiPolygon', () => {
    const geom = synthesizeGeometryFromAreaDesc('Dane, WI; Rock, WI', lookup);
    expect(geom?.type).toBe('MultiPolygon');
    // Dane contributes 1 polygon, Rock contributes 1 polygon → 2 total.
    expect(geom?.coordinates).toHaveLength(2);
  });

  it('returns null when no county names resolve', () => {
    expect(synthesizeGeometryFromAreaDesc('Milwaukee, WI', lookup)).toBeNull();
  });

  it('returns null for empty area_desc', () => {
    expect(synthesizeGeometryFromAreaDesc('', lookup)).toBeNull();
  });

  it('skips unknown counties but includes known ones in the same list', () => {
    const geom = synthesizeGeometryFromAreaDesc('Dane, WI; Milwaukee, WI; Rock, WI', lookup);
    expect(geom?.coordinates).toHaveLength(2);
  });

  it('ignores out-of-state segments sharing a name with a WI county', () => {
    // Real-world cross-state watch. Without state filtering, "Rock, IL" would
    // be stripped to just "Rock" and hit WI's Rock polygon a second time.
    const geom = synthesizeGeometryFromAreaDesc('Rock, IL; Dane, WI', lookup);
    // Only Dane should hydrate (1 polygon). Rock, IL is dropped.
    expect(geom?.coordinates).toHaveLength(1);
  });

  it('hydrates each duplicate county against its own state geometry (regression)', () => {
    // Pre-fix, both "Washington, IA" and "Washington, WI" would resolve to
    // whichever polygon happened to load last — the other state silently
    // vanished. Post-fix, each lookup uses its own state key and both
    // polygons are included.
    const geom = synthesizeGeometryFromAreaDesc('Washington, IA; Washington, WI', lookup, {
      allowedStates: ['IA', 'WI'],
    });
    expect(geom?.coordinates).toHaveLength(2);
    // Must contain the IA coordinates, not just WI duplicated.
    expect(geom?.coordinates).toContainEqual(WASHINGTON_IA_POLY.coordinates);
    expect(geom?.coordinates).toContainEqual(WASHINGTON_WI_POLY.coordinates);
  });
});
