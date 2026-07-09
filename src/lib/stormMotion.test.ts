import { describe, it, expect, vi } from 'vitest';
import distance from '@turf/distance';
import destination from '@turf/destination';
import { point } from '@turf/helpers';
import {
  buildMotionFeatures,
  ktToMph,
  MOTION_LAYER_IDS,
  setMotionVisibility,
  type LayerVisibilityMap,
  type MotionSourceAlert,
  type StormMotion,
} from './stormMotion';

// A throwaway polygon used anywhere a test needs a non-null geometry. The
// actual shape doesn't matter — buildMotionFeatures only checks for presence.
const STUB_GEOMETRY: GeoJSON.Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-89.5, 42.5],
      [-89.4, 42.5],
      [-89.4, 42.6],
      [-89.5, 42.6],
      [-89.5, 42.5],
    ],
  ],
};

// Helper — build a plausible alert payload. Only `storm_motion` varies between
// cases; the rest is just identifying metadata the features propagate.
// `geometry` defaults to a stub polygon so the core suite keeps rendering; the
// null-geometry tests override it explicitly.
function alert(
  motion: StormMotion | null | undefined,
  overrides: Partial<MotionSourceAlert> = {},
): MotionSourceAlert {
  return {
    nws_id: 'KMKX.TO.W.0001',
    event_type: 'Tornado Warning',
    storm_motion: motion,
    geometry: STUB_GEOMETRY,
    ...overrides,
  };
}

const baseMotion: StormMotion = {
  origin_lat: 42.58,
  origin_lon: -89.47,
  direction_deg: 270, // storm FROM the west → travels east
  speed_kt: 30,
  valid_at: '2026-04-17T20:15:00Z',
};

describe('buildMotionFeatures', () => {
  it('returns an empty FeatureCollection for an empty alerts array', () => {
    const fc = buildMotionFeatures([]);
    expect(fc).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('skips alerts with no storm_motion', () => {
    const fc = buildMotionFeatures([alert(null), alert(undefined)]);
    expect(fc.features).toHaveLength(0);
  });

  it('emits 6 features per motion alert (origin + line + 3 ticks + label)', () => {
    const fc = buildMotionFeatures([alert(baseMotion)]);
    expect(fc.features).toHaveLength(6);

    const kinds = fc.features.map((f) => f.properties?.kind);
    expect(kinds).toEqual(['origin', 'line', 'tick', 'tick', 'tick', 'label']);
  });

  it('emits 12 features for 2 motion-bearing alerts alongside 1 without', () => {
    const fc = buildMotionFeatures([
      alert(baseMotion, { nws_id: 'A' }),
      alert(null, { nws_id: 'B' }),
      alert(baseMotion, { nws_id: 'C' }),
    ]);
    expect(fc.features).toHaveLength(12);
    // Order is preserved per-alert — first 6 belong to A, next 6 to C.
    expect(fc.features[0].properties?.nws_id).toBe('A');
    expect(fc.features[5].properties?.nws_id).toBe('A');
    expect(fc.features[6].properties?.nws_id).toBe('C');
    expect(fc.features[11].properties?.nws_id).toBe('C');
  });

  it('places origin Point exactly at [origin_lon, origin_lat] with no projection', () => {
    const fc = buildMotionFeatures([alert(baseMotion)]);
    const origin = fc.features.find((f) => f.properties?.kind === 'origin');
    expect(origin?.geometry.type).toBe('Point');
    const coords = (origin?.geometry as GeoJSON.Point).coordinates;
    expect(coords).toEqual([baseMotion.origin_lon, baseMotion.origin_lat]);
  });

  it('inverts direction_deg into forward bearing: 270→90, 0→180, 180→0, 359→179, 90→270', () => {
    const cases: Array<[number, number]> = [
      [270, 90],
      [0, 180],
      [180, 0],
      [359, 179],
      [90, 270],
    ];
    for (const [fromDeg, expectedBearing] of cases) {
      const fc = buildMotionFeatures([alert({ ...baseMotion, direction_deg: fromDeg })]);
      const tick = fc.features.find(
        (f) => f.properties?.kind === 'tick' && f.properties?.tick === 45,
      );
      expect(tick?.properties?.bearing).toBe(expectedBearing);
    }
  });

  it('projects the line terminus ~41.67 km from origin at 30 KT over 45 min', () => {
    // 30 KT * 0.75 h = 22.5 NM = 22.5 * 1.852 km ≈ 41.67 km.
    const fc = buildMotionFeatures([alert(baseMotion)]);
    const line = fc.features.find((f) => f.properties?.kind === 'line');
    const coords = (line?.geometry as GeoJSON.LineString).coordinates;
    expect(coords).toHaveLength(2);
    const distKm = distance(point(coords[0]), point(coords[1]), {
      units: 'kilometers',
    });
    expect(distKm).toBeGreaterThan(41.17);
    expect(distKm).toBeLessThan(42.17);
  });

  it('labels tick features with the correct tick property and carries bearing on all three', () => {
    const fc = buildMotionFeatures([alert(baseMotion)]);
    const ticks = fc.features.filter((f) => f.properties?.kind === 'tick');
    expect(ticks).toHaveLength(3);
    const tickVals = ticks.map((t) => t.properties?.tick);
    expect(tickVals).toEqual([15, 30, 45]);
    // direction_deg=270 → forwardBearing=90. All three ticks carry it.
    for (const t of ticks) {
      expect(t.properties?.bearing).toBe(90);
    }
  });

  it('places the 30-min tick approximately halfway between origin and 45-min terminus', () => {
    const fc = buildMotionFeatures([alert(baseMotion)]);
    const origin = fc.features.find((f) => f.properties?.kind === 'origin');
    const tick30 = fc.features.find(
      (f) => f.properties?.kind === 'tick' && f.properties?.tick === 30,
    );
    const line = fc.features.find((f) => f.properties?.kind === 'line');

    const originPt = origin?.geometry as GeoJSON.Point;
    const tick30Pt = tick30?.geometry as GeoJSON.Point;
    const terminus = (line?.geometry as GeoJSON.LineString).coordinates[1];

    const originToTick = distance(point(originPt.coordinates), point(tick30Pt.coordinates), {
      units: 'kilometers',
    });
    const originToTerminus = distance(point(originPt.coordinates), point(terminus), {
      units: 'kilometers',
    });
    // 30-min mark sits at 2/3 of the 45-min distance (since 30/45 = 2/3).
    const expected = originToTerminus * (2 / 3);
    expect(Math.abs(originToTick - expected)).toBeLessThan(0.5);
  });

  it('propagates event, valid_at, and nws_id onto every emitted feature', () => {
    const fc = buildMotionFeatures([
      alert(baseMotion, { nws_id: 'KMKX.SV.W.0099', event_type: 'Severe Thunderstorm Warning' }),
    ]);
    for (const f of fc.features) {
      expect(f.properties?.event).toBe('Severe Thunderstorm Warning');
      expect(f.properties?.valid_at).toBe(baseMotion.valid_at);
      expect(f.properties?.nws_id).toBe('KMKX.SV.W.0099');
    }
  });

  it('matches hand-computed geometry: origin (42.58, -89.47), dir=270, 30 KT → terminus ≈ (42.58, -88.962)', () => {
    // Hand sanity check:
    //   45 min @ 30 KT = 22.5 NM ≈ 41.67 km due east (forward bearing 90°).
    //   1° longitude at 42.58°N ≈ 111.32 × cos(42.58°) ≈ 81.99 km.
    //   41.67 / 81.99 ≈ 0.508° east → lon ≈ -89.47 + 0.508 = -88.962°.
    //   Latitude stays ≈ 42.58°N (great-circle correction negligible over 42 km).
    //
    // We also cross-check against turf.destination directly — asserting our
    // implementation invokes turf with the same arguments we would.
    const fc = buildMotionFeatures([alert(baseMotion)]);
    const line = fc.features.find((f) => f.properties?.kind === 'line');
    const terminus = (line?.geometry as GeoJSON.LineString).coordinates[1];

    const expected = destination(
      point([baseMotion.origin_lon, baseMotion.origin_lat]),
      30 * 0.75 * 1.852,
      90, // forward bearing when direction_deg=270
      { units: 'kilometers' },
    ).geometry.coordinates;

    expect(terminus[0]).toBeCloseTo(expected[0], 6);
    expect(terminus[1]).toBeCloseTo(expected[1], 6);

    // Hand-derived tolerance check — loose, just an order-of-magnitude guard.
    expect(terminus[1]).toBeCloseTo(42.58, 1);
    expect(terminus[0]).toBeGreaterThan(-88.99);
    expect(terminus[0]).toBeLessThan(-88.93);
  });

  it('handles a stationary storm (speed_kt=0) without throwing: terminus === origin', () => {
    const stationary: StormMotion = { ...baseMotion, speed_kt: 0 };
    const fc = buildMotionFeatures([alert(stationary)]);
    expect(fc.features).toHaveLength(6);

    const origin = fc.features.find((f) => f.properties?.kind === 'origin');
    const line = fc.features.find((f) => f.properties?.kind === 'line');
    const originCoords = (origin?.geometry as GeoJSON.Point).coordinates;
    const lineCoords = (line?.geometry as GeoJSON.LineString).coordinates;

    expect(lineCoords).toHaveLength(2);
    // turf.destination(p, 0, bearing) returns p; both line endpoints collapse
    // onto the origin.
    expect(lineCoords[0]).toEqual(originCoords);
    const dist = distance(point(lineCoords[0]), point(lineCoords[1]), {
      units: 'kilometers',
    });
    expect(dist).toBeLessThan(1e-9);
  });

  // ---------------------------------------------------------------------------
  // Filter-drift regression coverage
  //
  // `snapshotToFeatures` in WeatherMap drops alerts whose geometry is null,
  // so the alerts source never renders them. Motion features are fed from the
  // same snapshot via a different path — if buildMotionFeatures didn't also
  // skip null-geometry alerts, a storm motion vector could render on the map
  // with no accompanying polygon. These tests lock in the alignment.
  // ---------------------------------------------------------------------------

  it('skips alerts with storm_motion but geometry === null (no orphan vectors)', () => {
    const fc = buildMotionFeatures([alert(baseMotion, { geometry: null })]);
    expect(fc).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('skips alerts with storm_motion but geometry === undefined', () => {
    const fc = buildMotionFeatures([alert(baseMotion, { geometry: undefined })]);
    expect(fc).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('emits 6 features when both storm_motion and geometry are present', () => {
    const fc = buildMotionFeatures([alert(baseMotion, { geometry: STUB_GEOMETRY })]);
    expect(fc.features).toHaveLength(6);
  });

  it('mixed input (motion+geo, motion+null, no motion) emits only the first alert’s 6 features', () => {
    const fc = buildMotionFeatures([
      alert(baseMotion, { nws_id: 'A', geometry: STUB_GEOMETRY }),
      alert(baseMotion, { nws_id: 'B', geometry: null }),
      alert(null, { nws_id: 'C', geometry: STUB_GEOMETRY }),
    ]);
    expect(fc.features).toHaveLength(6);
    for (const f of fc.features) {
      expect(f.properties?.nws_id).toBe('A');
    }
  });

  // ---------------------------------------------------------------------------
  // Speed label coverage — the label feature makes velocity legible on the map.
  // ---------------------------------------------------------------------------

  it('emits one label feature at the 45-min terminus with rounded mph', () => {
    const fc = buildMotionFeatures([alert(baseMotion)]);
    const line = fc.features.find((f) => f.properties?.kind === 'line');
    const label = fc.features.find((f) => f.properties?.kind === 'label');

    expect(label).toBeDefined();
    expect(label?.geometry.type).toBe('Point');

    const terminus = (line?.geometry as GeoJSON.LineString).coordinates[1];
    const labelCoords = (label?.geometry as GeoJSON.Point).coordinates;
    expect(labelCoords[0]).toBeCloseTo(terminus[0], 9);
    expect(labelCoords[1]).toBeCloseTo(terminus[1], 9);

    // 30 kt → 34.52 mph → 35 mph (Math.round).
    expect(label?.properties?.speed_kt).toBe(30);
    expect(label?.properties?.speed_mph).toBe(35);
    expect(label?.properties?.label).toBe('35 mph');
    expect(label?.properties?.bearing).toBe(90);
  });

  it('never emits a label for alerts without storm_motion', () => {
    const fc = buildMotionFeatures([alert(null)]);
    expect(fc.features.find((f) => f.properties?.kind === 'label')).toBeUndefined();
  });

  it('labels a stationary storm as "0 mph" at the origin', () => {
    const stationary: StormMotion = { ...baseMotion, speed_kt: 0 };
    const fc = buildMotionFeatures([alert(stationary)]);
    const origin = fc.features.find((f) => f.properties?.kind === 'origin');
    const label = fc.features.find((f) => f.properties?.kind === 'label');
    const originCoords = (origin?.geometry as GeoJSON.Point).coordinates;
    const labelCoords = (label?.geometry as GeoJSON.Point).coordinates;

    expect(label?.properties?.label).toBe('0 mph');
    expect(labelCoords).toEqual(originCoords);
  });
});

// -----------------------------------------------------------------------------
// Optional `points` field — multi-cell storm line support
//
// The ingest parser emits an optional `points[]` array when an NWS warning
// carries multiple reported storm positions (common for storm lines that span
// several cells). The client type accepts it for forward-compat, but the
// renderer continues to project from the single origin + bearing. These tests
// lock in both the type acceptance and the renderer-pass-through contract.
// -----------------------------------------------------------------------------

describe('StormMotion with optional points field', () => {
  it('type accepts a motion with points (compile-time + runtime)', () => {
    const withPoints: StormMotion = {
      origin_lat: 44.31,
      origin_lon: -91.8,
      direction_deg: 244,
      speed_kt: 38,
      valid_at: '2026-04-17T20:29:00Z',
      points: [
        [44.31, -91.8],
        [44.23, -91.75],
        [44.02, -91.77],
      ],
    };
    expect(withPoints.points).toHaveLength(3);
    expect(withPoints.points?.[0]).toEqual([44.31, -91.8]);
  });

  it('type accepts a motion without points (field is truly optional)', () => {
    const withoutPoints: StormMotion = {
      origin_lat: 44.31,
      origin_lon: -91.8,
      direction_deg: 244,
      speed_kt: 38,
      valid_at: '2026-04-17T20:29:00Z',
    };
    expect(withoutPoints.points).toBeUndefined();
  });

  it('buildMotionFeatures ignores the points field — output is identical to a points-less motion', () => {
    // Same origin/bearing/speed/timestamp; one carries `points`, the other
    // does not. The renderer must produce deeply-equal feature collections.
    const baseline: StormMotion = {
      origin_lat: 44.31,
      origin_lon: -91.8,
      direction_deg: 244,
      speed_kt: 38,
      valid_at: '2026-04-17T20:29:00Z',
    };
    const withPoints: StormMotion = {
      ...baseline,
      points: [
        [44.31, -91.8],
        [44.23, -91.75],
        [44.02, -91.77],
      ],
    };

    const fcBaseline = buildMotionFeatures([alert(baseline, { nws_id: 'X' })]);
    const fcWithPoints = buildMotionFeatures([alert(withPoints, { nws_id: 'X' })]);

    expect(fcWithPoints).toEqual(fcBaseline);
  });
});

describe('ktToMph', () => {
  it('converts kt to mph with rounding', () => {
    expect(ktToMph(0)).toBe(0);
    expect(ktToMph(30)).toBe(35); // 30 * 1.15078 = 34.52 → 35
    expect(ktToMph(50)).toBe(58); // 50 * 1.15078 = 57.54 → 58
    expect(ktToMph(100)).toBe(115);
  });
});

// -----------------------------------------------------------------------------
// MOTION_LAYER_IDS + setMotionVisibility
//
// The map component toggles storm-motion layer visibility in forecast mode.
// These tests pin the layer-ID contract and verify the pure helper handles
// the "layer not yet registered" edge case without throwing.
// -----------------------------------------------------------------------------

describe('MOTION_LAYER_IDS', () => {
  it('contains exactly 5 entries in a stable order (includes motion-label)', () => {
    expect(MOTION_LAYER_IDS).toEqual([
      'motion-line',
      'motion-origin',
      'motion-head',
      'motion-ticks',
      'motion-label',
    ]);
    expect(MOTION_LAYER_IDS).toHaveLength(5);
  });
});

describe('setMotionVisibility', () => {
  // Build a fake MapLibre surface that records setLayoutProperty calls and
  // reports whether each queried layer exists.
  function makeMap(presentLayers: ReadonlySet<string>): LayerVisibilityMap & {
    setLayoutProperty: ReturnType<typeof vi.fn>;
    getLayer: ReturnType<typeof vi.fn>;
  } {
    return {
      setLayoutProperty: vi.fn(),
      getLayer: vi.fn((id: string) => (presentLayers.has(id) ? { id } : undefined)),
    };
  }

  it('sets visibility to "none" on every present motion layer when visible=false', () => {
    const allLayers = new Set<string>(MOTION_LAYER_IDS);
    const map = makeMap(allLayers);

    setMotionVisibility(map, false);

    expect(map.setLayoutProperty).toHaveBeenCalledTimes(MOTION_LAYER_IDS.length);
    for (const id of MOTION_LAYER_IDS) {
      expect(map.setLayoutProperty).toHaveBeenCalledWith(id, 'visibility', 'none');
    }
  });

  it('sets visibility to "visible" on every present motion layer when visible=true', () => {
    const allLayers = new Set<string>(MOTION_LAYER_IDS);
    const map = makeMap(allLayers);

    setMotionVisibility(map, true);

    expect(map.setLayoutProperty).toHaveBeenCalledTimes(MOTION_LAYER_IDS.length);
    for (const id of MOTION_LAYER_IDS) {
      expect(map.setLayoutProperty).toHaveBeenCalledWith(id, 'visibility', 'visible');
    }
  });

  it('is a no-op for layers that are not registered (does not throw)', () => {
    const map = makeMap(new Set());

    expect(() => setMotionVisibility(map, false)).not.toThrow();
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });

  it('only updates the subset of motion layers that currently exist', () => {
    const partial = new Set<string>(['motion-line', 'motion-head']);
    const map = makeMap(partial);

    setMotionVisibility(map, false);

    expect(map.setLayoutProperty).toHaveBeenCalledTimes(2);
    expect(map.setLayoutProperty).toHaveBeenCalledWith('motion-line', 'visibility', 'none');
    expect(map.setLayoutProperty).toHaveBeenCalledWith('motion-head', 'visibility', 'none');
    expect(map.setLayoutProperty).not.toHaveBeenCalledWith(
      'motion-origin',
      'visibility',
      expect.anything(),
    );
    expect(map.setLayoutProperty).not.toHaveBeenCalledWith(
      'motion-ticks',
      'visibility',
      expect.anything(),
    );
  });
});
