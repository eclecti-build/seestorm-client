import { describe, it, expect } from 'vitest';
import {
  alertFamily,
  buildAlertViews,
  colorForEvent,
  FALLBACK_COLOR,
  FAMILY_ORDER,
  groupByFamily,
  ingestToWeatherAlert,
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
    area: 'WI',
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
