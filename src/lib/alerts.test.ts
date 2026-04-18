import { describe, it, expect } from 'vitest';
import {
  alertFamily,
  alertTouchesPoint,
  alertTouchesState,
  buildAlertViews,
  colorForEvent,
  FALLBACK_COLOR,
  FAMILY_ORDER,
  groupByFamily,
  ingestToWeatherAlert,
  parseIngestSnapshot,
  priorityForEvent,
  resolveAlertUrl,
  tierForEvent,
  type IngestAlert,
  type IngestSnapshot,
} from './alerts';
import { buildCountyLookup } from './countyGeometry';

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

function ingest(overrides: Partial<IngestAlert> = {}): IngestAlert {
  return {
    nws_id: 'KMKX.TO.W.0001',
    event_type: 'Tornado Warning',
    severity: 'Extreme',
    headline: 'Tornado Warning for Dane County',
    description: 'Take shelter now.',
    area_desc: 'Dane, WI',
    geometry: STUB_GEOMETRY,
    effective_at: '2026-04-17T20:00:00Z',
    expires_at: '2026-04-17T20:30:00Z',
    ...overrides,
  };
}

function snap(alerts: IngestAlert[]): IngestSnapshot {
  return {
    generated_at: '2026-04-17T20:00:00Z',
    areas: ['WI'],
    alert_count: alerts.length,
    alerts,
  };
}

describe('tierForEvent', () => {
  it('classifies Warning, Watch, and everything else', () => {
    expect(tierForEvent('Tornado Warning')).toBe('Warning');
    expect(tierForEvent('Severe Thunderstorm Watch')).toBe('Watch');
    expect(tierForEvent('Special Weather Statement')).toBe('Advisory');
    expect(tierForEvent('Flood Advisory')).toBe('Advisory');
  });
});

describe('alertFamily', () => {
  it('groups Tornado / Severe Thunderstorm / Flash Flood by substring', () => {
    expect(alertFamily('Tornado Warning')).toBe('Tornado');
    expect(alertFamily('Tornado Emergency')).toBe('Tornado');
    expect(alertFamily('Severe Thunderstorm Warning')).toBe('Severe Thunderstorm');
    expect(alertFamily('Flash Flood Watch')).toBe('Flash Flood');
  });

  it('puts unknown events in the Other bucket', () => {
    expect(alertFamily('Winter Storm Warning')).toBe('Other');
    expect(alertFamily('Special Weather Statement')).toBe('Other');
  });

  it('keeps FAMILY_ORDER stable', () => {
    expect(FAMILY_ORDER).toEqual(['Tornado', 'Severe Thunderstorm', 'Flash Flood', 'Other']);
  });
});

describe('colorForEvent / priorityForEvent', () => {
  it('returns palette hex for known events and falls back to gray', () => {
    expect(colorForEvent('Tornado Warning')).toBe('#FF0000');
    expect(colorForEvent('Tornado Watch')).toBe('#FFFF00');
    expect(colorForEvent('Unknown Event')).toBe(FALLBACK_COLOR);
  });

  it('ranks warnings above watches of the same family', () => {
    expect(priorityForEvent('Tornado Warning')).toBeLessThan(priorityForEvent('Tornado Watch'));
    expect(priorityForEvent('Severe Thunderstorm Warning')).toBeLessThan(
      priorityForEvent('Severe Thunderstorm Watch'),
    );
    expect(priorityForEvent('Bogus Event')).toBe(99);
  });
});

describe('resolveAlertUrl', () => {
  it('prefers an ingest-provided url over the fallback', () => {
    expect(resolveAlertUrl({ url: 'https://example.com/a', nws_id: 'KMKX.TO.W.0001' })).toBe(
      'https://example.com/a',
    );
  });

  it('builds the fallback from nws_id when url is missing', () => {
    expect(resolveAlertUrl({ nws_id: 'KMKX.TO.W.0001' })).toBe(
      'https://api.weather.gov/alerts/KMKX.TO.W.0001',
    );
  });

  it('url-encodes the nws_id', () => {
    // Real NWS IDs contain dots and sometimes odd characters; encoding keeps
    // us safe against ids that add `:` or `/` in future product variants.
    expect(resolveAlertUrl({ nws_id: 'weird/id?x=1' })).toBe(
      'https://api.weather.gov/alerts/weird%2Fid%3Fx%3D1',
    );
  });

  it('returns null when neither url nor nws_id is present', () => {
    expect(resolveAlertUrl({})).toBeNull();
    expect(resolveAlertUrl({ url: null, nws_id: null })).toBeNull();
    expect(resolveAlertUrl({ url: '', nws_id: '' })).toBeNull();
  });
});

describe('ingestToWeatherAlert', () => {
  it('copies fields, sets url via resolveAlertUrl, and preserves nwsId', () => {
    const wa = ingestToWeatherAlert(ingest({ nws_id: 'KMKX.TO.W.0007' }));
    expect(wa.properties.event).toBe('Tornado Warning');
    expect(wa.properties.areaDesc).toBe('Dane, WI');
    expect(wa.properties.nwsId).toBe('KMKX.TO.W.0007');
    expect(wa.properties.url).toBe('https://api.weather.gov/alerts/KMKX.TO.W.0007');
  });

  it('uses the ingest-provided url when present', () => {
    const wa = ingestToWeatherAlert(ingest({ url: 'https://nws.example/a' }));
    expect(wa.properties.url).toBe('https://nws.example/a');
  });

  it('carries null geometry through unchanged', () => {
    const wa = ingestToWeatherAlert(ingest({ geometry: null }));
    expect(wa.geometry).toBeNull();
  });
});

describe('buildAlertViews', () => {
  it('maps only geometry-bearing alerts, sorts by priority', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'A', event_type: 'Tornado Watch' }), // priority 3
        ingest({ nws_id: 'B', event_type: 'Tornado Warning' }), // priority 0
        ingest({ nws_id: 'C', event_type: 'Flash Flood Warning' }), // priority 2
      ]),
    );
    expect(out.mapFeatures.type).toBe('FeatureCollection');
    expect(out.mapFeatures.features.map((f) => f.properties.nwsId)).toEqual(['B', 'C', 'A']);
  });

  it('keeps null-geometry alerts in listAlerts but excludes them from mapFeatures', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'POLY', geometry: STUB_GEOMETRY }),
        ingest({ nws_id: 'COUNTY_WATCH', event_type: 'Tornado Watch', geometry: null }),
      ]),
    );
    expect(out.mapFeatures.features.map((f) => f.properties.nwsId)).toEqual(['POLY']);
    expect(out.listAlerts.map((a) => a.properties.nwsId).sort()).toEqual(['COUNTY_WATCH', 'POLY']);
  });

  it('hydrates zone-only alerts onto the map when a countyLookup resolves area_desc', () => {
    const daneCountyFC: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { NAME: 'Dane' },
          geometry: STUB_GEOMETRY,
        },
      ],
    };
    const countyLookup = buildCountyLookup(daneCountyFC);
    const out = buildAlertViews(
      snap([
        ingest({
          nws_id: 'WATCH',
          event_type: 'Tornado Watch',
          area_desc: 'Dane, WI',
          geometry: null,
        }),
        ingest({
          nws_id: 'UNKNOWN',
          event_type: 'Tornado Watch',
          area_desc: 'Somewhere Else, WI',
          geometry: null,
        }),
      ]),
      { countyLookup },
    );
    expect(out.mapFeatures.features.map((f) => f.properties.nwsId)).toEqual(['WATCH']);
    // Both alerts stay in the side panel regardless of hydration success.
    expect(out.listAlerts.map((a) => a.properties.nwsId).sort()).toEqual(['UNKNOWN', 'WATCH']);
    // Hydrated feature carries a synthesized MultiPolygon.
    expect(out.mapFeatures.features[0].geometry?.type).toBe('MultiPolygon');
  });

  it('leaves zone-only alerts off the map when no countyLookup is supplied', () => {
    const out = buildAlertViews(
      snap([
        ingest({
          nws_id: 'WATCH',
          event_type: 'Tornado Watch',
          area_desc: 'Dane, WI',
          geometry: null,
        }),
      ]),
    );
    expect(out.mapFeatures.features).toHaveLength(0);
    expect(out.listAlerts).toHaveLength(1);
  });

  it('list sort is stable by priority (warnings first, then watches)', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'TW', event_type: 'Tornado Watch', geometry: null }),
        ingest({ nws_id: 'SW', event_type: 'Severe Thunderstorm Warning' }),
        ingest({ nws_id: 'TO', event_type: 'Tornado Warning' }),
      ]),
    );
    expect(out.listAlerts.map((a) => a.properties.event)).toEqual([
      'Tornado Warning',
      'Severe Thunderstorm Warning',
      'Tornado Watch',
    ]);
  });
});

describe('parseIngestSnapshot', () => {
  it('accepts a v2 snapshot with schema_version=2 and areas[]', () => {
    const out = parseIngestSnapshot({
      schema_version: 2,
      generated_at: '2026-04-17T20:00:00Z',
      areas: ['WI', 'IL'],
      alert_count: 0,
      alerts: [],
    });
    expect(out.areas).toEqual(['WI', 'IL']);
    expect(out.schema_version).toBe(2);
  });

  it('coerces a legacy v1 snapshot (no schema_version, scalar area) into the v2 shape', () => {
    const out = parseIngestSnapshot({
      generated_at: '2026-04-17T20:00:00Z',
      area: 'WI',
      alert_count: 0,
      alerts: [],
    });
    expect(out.areas).toEqual(['WI']);
    expect(out.schema_version).toBeUndefined();
  });

  it('throws on an unknown future schema_version', () => {
    expect(() =>
      parseIngestSnapshot({
        schema_version: 99,
        generated_at: '2026-04-17T20:00:00Z',
        areas: ['WI'],
        alert_count: 0,
        alerts: [],
      }),
    ).toThrow(/schema_version/);
  });

  it('throws on missing generated_at or alerts', () => {
    expect(() => parseIngestSnapshot({ areas: ['WI'], alerts: [] })).toThrow(/generated_at/);
    expect(() =>
      parseIngestSnapshot({ generated_at: '2026-04-17T20:00:00Z', areas: ['WI'] }),
    ).toThrow(/alerts/);
  });

  it('throws on non-object input', () => {
    expect(() => parseIngestSnapshot(null)).toThrow();
    expect(() => parseIngestSnapshot('snapshot')).toThrow();
  });
});

describe('alertTouchesState', () => {
  it('matches when area_state equals the user state (case-insensitive)', () => {
    expect(alertTouchesState(ingest({ area_state: 'WI' }), 'WI')).toBe(true);
    expect(alertTouchesState(ingest({ area_state: 'wi' }), 'WI')).toBe(true);
    expect(alertTouchesState(ingest({ area_state: 'IL' }), 'WI')).toBe(false);
  });

  it('matches when states[] includes the user state (cross-border alert)', () => {
    expect(alertTouchesState(ingest({ area_state: 'IL', states: ['IL', 'WI'] }), 'WI')).toBe(true);
    expect(alertTouchesState(ingest({ states: ['MN', 'WI'] }), 'IL')).toBe(false);
  });

  it('returns true when the alert has no state metadata (legacy v1 fallback)', () => {
    expect(alertTouchesState(ingest({ area_state: null }), 'WI')).toBe(true);
  });

  // Regression: on 2026-04-17 a WI Flood Watch shipped with `states: []`
  // because ingest couldn't derive states for that zone-aggregate product.
  // The strict v2 path dropped it for every WI user with a saved ZIP — a
  // live safety product was hidden. Empty array must be treated the same
  // as a missing field and fall through to the v1 "can't filter" path.
  it('returns true when states[] is empty and area_state is missing', () => {
    expect(alertTouchesState(ingest({ area_state: null, states: [] }), 'WI')).toBe(true);
    expect(alertTouchesState(ingest({ states: [] }), 'WI')).toBe(true);
  });

  it('still respects area_state when states[] is empty but area_state is present', () => {
    // Empty states[] doesn't mean "ignore everything" — if area_state is
    // populated, strict matching still applies.
    expect(alertTouchesState(ingest({ area_state: 'WI', states: [] }), 'WI')).toBe(true);
    expect(alertTouchesState(ingest({ area_state: 'IL', states: [] }), 'WI')).toBe(false);
  });
});

describe('alertTouchesPoint', () => {
  // STUB_GEOMETRY is a small Polygon roughly at:
  //   lon: -89.5 to -89.4, lat: 42.5 to 42.6 (southern Wisconsin)
  // Picking points clearly inside / outside / on the boundary makes the
  // PiP behavior assertion-able without floating-point quirks.
  const inside = { lat: 42.55, lon: -89.45, state: 'WI' };
  const outside = { lat: 41.0, lon: -88.0, state: 'IL' };

  it('returns true when the point is inside the alert polygon', () => {
    expect(alertTouchesPoint(ingest(), inside)).toBe(true);
  });

  it('returns false when the point is outside the alert polygon and state differs', () => {
    // Polygon is in WI, point is in IL — both polygon-PiP miss AND state
    // fallback miss should produce false.
    expect(alertTouchesPoint(ingest({ area_state: 'WI' }), outside)).toBe(false);
  });

  it('falls back to state match for zone-only alerts (geometry: null)', () => {
    // Watches and broad Advisories ship without polygon geometry. We must
    // still surface them when they touch the user's state — otherwise a
    // user in IL never sees an Illinois Tornado Watch.
    const zoneOnly = ingest({ geometry: null, area_state: 'IL' });
    expect(alertTouchesPoint(zoneOnly, outside)).toBe(true);
    expect(alertTouchesPoint(zoneOnly, inside)).toBe(false); // user in WI shouldn't see IL-only watch
  });

  it('handles MultiPolygon geometries (NWS ships these for disjoint footprints)', () => {
    const multi = ingest({
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          // First polygon — same as STUB_GEOMETRY
          [
            [
              [-89.5, 42.5],
              [-89.4, 42.5],
              [-89.4, 42.6],
              [-89.5, 42.6],
              [-89.5, 42.5],
            ],
          ],
          // Second polygon — disjoint, in IL
          [
            [
              [-88.0, 41.0],
              [-87.9, 41.0],
              [-87.9, 41.1],
              [-88.0, 41.1],
              [-88.0, 41.0],
            ],
          ],
        ],
      },
    });
    expect(alertTouchesPoint(multi, inside)).toBe(true);
    expect(alertTouchesPoint(multi, { lat: 41.05, lon: -87.95, state: 'IL' })).toBe(true);
    // Point that's outside both polygons and not in the alert's state.
    expect(alertTouchesPoint(multi, { lat: 35.0, lon: -85.0, state: 'TN' })).toBe(false);
  });

  it('falls through to state match for unsupported geometry types (defensive)', () => {
    // Point geometry shouldn't crash the PiP — it should just fail the
    // polygon test and defer to state-level matching.
    const pointGeom = ingest({
      geometry: { type: 'Point', coordinates: [-89.45, 42.55] } as GeoJSON.Geometry,
      area_state: 'WI',
    });
    expect(alertTouchesPoint(pointGeom, inside)).toBe(true); // state match
    expect(alertTouchesPoint(pointGeom, outside)).toBe(false);
  });
});

describe('buildAlertViews — userPoint filter', () => {
  const inside = { lat: 42.55, lon: -89.45, state: 'WI' };

  it('keeps alerts whose polygon contains the user point', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'IN-POLY' }), // polygon contains `inside`
        ingest({
          nws_id: 'OUT-POLY',
          area_state: 'WI',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-90.0, 43.0],
                [-89.9, 43.0],
                [-89.9, 43.1],
                [-90.0, 43.1],
                [-90.0, 43.0],
              ],
            ],
          },
        }),
      ]),
      { userPoint: inside },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId)).toEqual(['IN-POLY']);
  });

  it('falls back to state match for zone-only alerts in the user state', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'POLY-MATCH' }), // polygon-precise match
        ingest({ nws_id: 'WATCH-WI', geometry: null, area_state: 'WI' }), // zone-only WI
        ingest({ nws_id: 'WATCH-IL', geometry: null, area_state: 'IL' }), // zone-only IL — should drop for WI user
      ]),
      { userPoint: inside },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId).sort()).toEqual([
      'POLY-MATCH',
      'WATCH-WI',
    ]);
  });

  it('userPoint takes precedence over userState when both are provided', () => {
    // Same alert that the userState filter (state=IL) would accept but the
    // userPoint filter rejects — point precedence means it's filtered OUT.
    const out = buildAlertViews(
      snap([
        ingest({
          nws_id: 'IL-POLY-FAR',
          area_state: 'IL',
          geometry: {
            // Polygon way outside the user's `inside` point
            type: 'Polygon',
            coordinates: [
              [
                [-95.0, 38.0],
                [-94.9, 38.0],
                [-94.9, 38.1],
                [-95.0, 38.1],
                [-95.0, 38.0],
              ],
            ],
          },
        }),
      ]),
      { userPoint: inside, userState: 'IL' }, // userState would accept; userPoint rejects
    );
    expect(out.listAlerts).toHaveLength(0);
  });

  it('exposes the same userPoint scoping in motionAlerts', () => {
    // Regression guard: motion arrows used to leak through unfiltered when
    // the userState filter was applied. The same invariant must hold for
    // userPoint — motion alerts must mirror polygon/list filtering.
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'IN-POLY' }),
        ingest({
          nws_id: 'OUT-POLY',
          area_state: 'WI',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-95.0, 38.0],
                [-94.9, 38.0],
                [-94.9, 38.1],
                [-95.0, 38.1],
                [-95.0, 38.0],
              ],
            ],
          },
        }),
      ]),
      { userPoint: inside },
    );
    expect(out.motionAlerts.map((a) => a.nws_id)).toEqual(['IN-POLY']);
  });
});

describe('buildAlertViews — userState filter', () => {
  it('keeps alerts whose area_state matches', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'WI1', area_state: 'WI' }),
        ingest({ nws_id: 'IL1', area_state: 'IL' }),
      ]),
      { userState: 'WI' },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId)).toEqual(['WI1']);
  });

  it('keeps cross-border alerts whose states[] includes the user state', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'BORDER', area_state: 'IL', states: ['IL', 'WI'] }),
        ingest({ nws_id: 'IL_ONLY', area_state: 'IL', states: ['IL'] }),
      ]),
      { userState: 'WI' },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId)).toEqual(['BORDER']);
  });

  it('returns all alerts when no userState is set', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'WI1', area_state: 'WI' }),
        ingest({ nws_id: 'IL1', area_state: 'IL' }),
      ]),
    );
    expect(out.listAlerts).toHaveLength(2);
  });

  it('exposes motionAlerts filtered to the same userState scope', () => {
    // Regression: motion arrows used to be rendered against snapshot.alerts
    // (unfiltered), so users with a saved ZIP saw arrows from every other
    // covered state leaking in. motionAlerts must mirror the userState filter.
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'WI1', area_state: 'WI' }),
        ingest({ nws_id: 'IL1', area_state: 'IL' }),
        ingest({ nws_id: 'BORDER', area_state: 'IL', states: ['IL', 'WI'] }),
      ]),
      { userState: 'WI' },
    );
    expect(out.motionAlerts.map((a) => a.nws_id)).toEqual(['WI1', 'BORDER']);
  });

  it('motionAlerts equals snapshot.alerts when no userState is set', () => {
    const input = snap([
      ingest({ nws_id: 'WI1', area_state: 'WI' }),
      ingest({ nws_id: 'IL1', area_state: 'IL' }),
    ]);
    const out = buildAlertViews(input);
    expect(out.motionAlerts).toEqual(input.alerts);
  });
});

describe('groupByFamily', () => {
  it('groups alerts by family and respects FAMILY_ORDER', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'FF', event_type: 'Flash Flood Warning' }),
        ingest({ nws_id: 'T1', event_type: 'Tornado Warning' }),
        ingest({ nws_id: 'T2', event_type: 'Tornado Watch', geometry: null }),
        ingest({ nws_id: 'STW', event_type: 'Severe Thunderstorm Warning' }),
        ingest({ nws_id: 'SWS', event_type: 'Special Weather Statement' }),
      ]),
    );
    const groups = groupByFamily(out.listAlerts);
    expect(groups.map((g) => g.family)).toEqual([
      'Tornado',
      'Severe Thunderstorm',
      'Flash Flood',
      'Other',
    ]);
    expect(groups[0].alerts.map((a) => a.properties.nwsId)).toEqual(['T1', 'T2']);
    expect(groups[3].alerts.map((a) => a.properties.event)).toEqual(['Special Weather Statement']);
  });

  it('drops empty families', () => {
    const out = buildAlertViews(snap([ingest({ nws_id: 'X', event_type: 'Tornado Warning' })]));
    const groups = groupByFamily(out.listAlerts);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('Tornado');
  });

  it('returns empty array for zero alerts', () => {
    expect(groupByFamily([])).toEqual([]);
  });
});
