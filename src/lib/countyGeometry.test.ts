import { describe, it, expect } from 'vitest';
import {
  buildCountyLookup,
  parseCountyNamesFromAreaDesc,
  synthesizeGeometryFromAreaDesc,
} from './countyGeometry';

function countyFC(
  entries: Array<{ name: string; poly?: GeoJSON.Polygon; multi?: GeoJSON.MultiPolygon }>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: entries.map((e) => ({
      type: 'Feature',
      properties: { NAME: e.name },
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

describe('parseCountyNamesFromAreaDesc', () => {
  it('extracts a single county', () => {
    expect(parseCountyNamesFromAreaDesc('Dane, WI')).toEqual(['Dane']);
  });

  it('splits on semicolons and strips the state suffix on each segment', () => {
    expect(parseCountyNamesFromAreaDesc('Dane, WI; Rock, WI; Green, WI')).toEqual([
      'Dane',
      'Rock',
      'Green',
    ]);
  });

  it('preserves multi-word county names', () => {
    expect(parseCountyNamesFromAreaDesc('Fond du Lac, WI; Eau Claire, WI')).toEqual([
      'Fond du Lac',
      'Eau Claire',
    ]);
  });

  it('handles missing state suffix', () => {
    expect(parseCountyNamesFromAreaDesc('Dane; Rock')).toEqual(['Dane', 'Rock']);
  });

  it('returns empty for empty input', () => {
    expect(parseCountyNamesFromAreaDesc('')).toEqual([]);
  });

  it('drops out-of-state segments by default (WI-only scope)', () => {
    // Cross-state Tornado Watch: Winnebago exists in both IL and WI.
    // Without filtering we'd hydrate WI's Winnebago twice (once per segment),
    // producing a wrong-state polygon alongside the correct one.
    expect(parseCountyNamesFromAreaDesc('Winnebago, IL; Boone, IL; Winnebago, WI')).toEqual([
      'Winnebago',
    ]);
  });

  it('honors custom allowedStates', () => {
    expect(
      parseCountyNamesFromAreaDesc('Dane, WI; Cook, IL', { allowedStates: ['WI', 'IL'] }),
    ).toEqual(['Dane', 'Cook']);
    expect(parseCountyNamesFromAreaDesc('Dane, WI; Cook, IL', { allowedStates: ['IL'] })).toEqual([
      'Cook',
    ]);
  });
});

describe('buildCountyLookup', () => {
  it('looks up by case-insensitive name', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Dane', poly: DANE_POLY }]));
    expect(lookup('Dane')).not.toBeNull();
    expect(lookup('dane')).not.toBeNull();
    expect(lookup('DANE')).not.toBeNull();
  });

  it('promotes Polygon features to MultiPolygon', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Dane', poly: DANE_POLY }]));
    const hit = lookup('Dane');
    expect(hit?.type).toBe('MultiPolygon');
    expect(hit?.coordinates).toEqual([DANE_POLY.coordinates]);
  });

  it('keeps MultiPolygon features as-is', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Rock', multi: ROCK_MULTI }]));
    expect(lookup('Rock')).toEqual(ROCK_MULTI);
  });

  it('returns null for unknown county', () => {
    const lookup = buildCountyLookup(countyFC([{ name: 'Dane', poly: DANE_POLY }]));
    expect(lookup('Milwaukee')).toBeNull();
  });

  it('skips features with null geometry or missing name', () => {
    // Cast through unknown because the GeoJSON type rejects `null` geometry,
    // but real FeatureCollections in the wild sometimes contain it and the
    // lookup builder must not crash on that case.
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { NAME: 'Dane' }, geometry: null },
        { type: 'Feature', properties: {}, geometry: DANE_POLY },
      ],
    } as unknown as GeoJSON.FeatureCollection;
    const lookup = buildCountyLookup(fc);
    expect(lookup('Dane')).toBeNull();
  });
});

describe('synthesizeGeometryFromAreaDesc', () => {
  const lookup = buildCountyLookup(
    countyFC([
      { name: 'Dane', poly: DANE_POLY },
      { name: 'Rock', multi: ROCK_MULTI },
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
    // Real-world cross-state watch. Without state filtering, "Winnebago, IL"
    // would resolve to WI's Dane polygon lookup — wait, there's no Winnebago
    // in our fixture, so the more pointed test: adding a matching "Rock, IL"
    // must not double-hydrate Rock (WI).
    const geom = synthesizeGeometryFromAreaDesc('Rock, IL; Dane, WI', lookup);
    // Only Dane should hydrate (1 polygon). Rock, IL is dropped.
    expect(geom?.coordinates).toHaveLength(1);
  });
});
