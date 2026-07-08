import { describe, it, expect } from 'vitest';
import {
  alertFamily,
  alertTouchesPoint,
  alertTouchesState,
  buildAlertViews,
  colorForEvent,
  deriveMultiStateDisplay,
  FALLBACK_COLOR,
  FAMILY_ORDER,
  filterAreaDescByState,
  groupByFamily,
  ingestToWeatherAlert,
  isExpiredInGrace,
  isPastGracePeriod,
  parseIngestSnapshot,
  priorityForEvent,
  resolveAlertUrl,
  tierForEvent,
  WARNING_COLORS,
  warningColorsFor,
  fallbackColorFor,
  type IngestAlert,
  type IngestSnapshot,
  type WeatherAlert,
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

const FIXTURE_NOW_MS = Date.parse('2026-04-17T20:00:00Z');

describe('tierForEvent', () => {
  it('classifies Warning, Watch, and everything else', () => {
    expect(tierForEvent('Tornado Warning')).toBe('Warning');
    expect(tierForEvent('Severe Thunderstorm Watch')).toBe('Watch');
    expect(tierForEvent('Special Weather Statement')).toBe('Advisory');
    expect(tierForEvent('Flood Advisory')).toBe('Advisory');
  });
});

describe('isPastGracePeriod / isExpiredInGrace', () => {
  const EXPIRES = '2026-04-17T20:30:00Z';
  const EXPIRES_MS = Date.parse(EXPIRES);

  it('isExpiredInGrace is false before expiry', () => {
    expect(isExpiredInGrace(EXPIRES, EXPIRES_MS - 1_000)).toBe(false);
  });

  it('isExpiredInGrace is true just past expiry, within the grace window', () => {
    expect(isExpiredInGrace(EXPIRES, EXPIRES_MS + 5 * 60_000)).toBe(true);
    expect(isPastGracePeriod(EXPIRES, EXPIRES_MS + 5 * 60_000)).toBe(false);
  });

  it('isPastGracePeriod is true once the grace period has fully elapsed', () => {
    expect(isPastGracePeriod(EXPIRES, EXPIRES_MS + 16 * 60_000)).toBe(true);
    expect(isExpiredInGrace(EXPIRES, EXPIRES_MS + 16 * 60_000)).toBe(false);
  });

  it('both fail OPEN (false) on an unparseable expires timestamp', () => {
    expect(isExpiredInGrace('not-a-timestamp', Date.now())).toBe(false);
    expect(isPastGracePeriod('not-a-timestamp', Date.now())).toBe(false);
  });
});

describe('alertFamily', () => {
  it('groups Tornado / Severe Thunderstorm / Flash Flood by substring', () => {
    expect(alertFamily('Tornado Warning')).toBe('Tornado');
    expect(alertFamily('Tornado Emergency')).toBe('Tornado');
    expect(alertFamily('Severe Thunderstorm Warning')).toBe('Severe Thunderstorm');
    expect(alertFamily('Flash Flood Watch')).toBe('Flash Flood');
  });

  it('keeps Flash Flood distinct from the slower-onset Flood family', () => {
    // Order-sensitive: 'Flash Flood' substring check must win over the
    // broader 'Flood' match so a Flash Flood Warning (rapid, life-threat)
    // never collapses into the plain-Flood bucket (slower river/areal).
    // These are different NWS product lines and belong in different
    // side-panel sections.
    expect(alertFamily('Flash Flood Warning')).toBe('Flash Flood');
    expect(alertFamily('Flood Warning')).toBe('Flood');
    expect(alertFamily('Flood Watch')).toBe('Flood');
    expect(alertFamily('Flood Advisory')).toBe('Flood');
    // FLS (Flood Statement) is the status/update message for an active
    // Flood Warning — it belongs in the Flood family, not Other.
    expect(alertFamily('Flood Statement')).toBe('Flood');
  });

  it('puts unknown events in the Other bucket', () => {
    expect(alertFamily('Winter Storm Warning')).toBe('Other');
    expect(alertFamily('Special Weather Statement')).toBe('Other');
  });

  it('keeps FAMILY_ORDER stable', () => {
    // Flood sits between Flash Flood and Other — water-hazard families
    // cluster together visually in the side panel.
    expect(FAMILY_ORDER).toEqual([
      'Tornado',
      'Severe Thunderstorm',
      'Flash Flood',
      'Flood',
      'Other',
    ]);
  });
});

describe('colorForEvent / priorityForEvent', () => {
  it('returns palette hex for known events and falls back to gray', () => {
    expect(colorForEvent('Tornado Warning')).toBe('#FF0000');
    expect(colorForEvent('Tornado Watch')).toBe('#FFFF00');
    expect(colorForEvent('Unknown Event')).toBe(FALLBACK_COLOR);
  });

  it('returns distinct palette entries for Freeze Warning + Watch', () => {
    // Regression guard: freeze/frost shipped without any palette entries in
    // the initial icon rollout, so Freeze Warning and Freeze Watch rendered
    // gray on the map and were absent from the legend entirely. Both must
    // now resolve to dedicated hexes, distinct from each other.
    //
    // Cousins — Hard Freeze Warning, Hard Freeze Watch, Frost Advisory —
    // intentionally fall back to FALLBACK_COLOR. The legend stays at the
    // 2-per-family shape; icon routing handles cousins via substring.
    const warning = colorForEvent('Freeze Warning');
    const watch = colorForEvent('Freeze Watch');
    expect(warning).not.toBe(FALLBACK_COLOR);
    expect(watch).not.toBe(FALLBACK_COLOR);
    expect(warning).not.toBe(watch);
    expect(colorForEvent('Hard Freeze Warning')).toBe(FALLBACK_COLOR);
    expect(colorForEvent('Frost Advisory')).toBe(FALLBACK_COLOR);
  });

  it('returns distinct, non-fallback palette entries for plain Flood products', () => {
    // Regression guard: the NWS "FLW" (Flood Warning) / "FLS" (Flood
    // Statement / Advisory) product line used to fall through to
    // FALLBACK_COLOR, rendering a life-safety Warning as a low-urgency
    // gray polygon on the map. All three plain-Flood tiers must now
    // resolve to dedicated hexes, distinct from each other AND from
    // their Flash Flood cousins (so the "flash = faster / more urgent"
    // visual hierarchy stays legible).
    const floodWarn = colorForEvent('Flood Warning');
    const floodWatch = colorForEvent('Flood Watch');
    const floodAdv = colorForEvent('Flood Advisory');
    expect(floodWarn).not.toBe(FALLBACK_COLOR);
    expect(floodWatch).not.toBe(FALLBACK_COLOR);
    expect(floodAdv).not.toBe(FALLBACK_COLOR);
    expect(new Set([floodWarn, floodWatch, floodAdv]).size).toBe(3);
    expect(floodWarn).not.toBe(colorForEvent('Flash Flood Warning'));
    expect(floodWatch).not.toBe(colorForEvent('Flash Flood Watch'));
  });

  it('routes Flood Statement to a non-fallback color in the Advisory tier', () => {
    // FLS asymmetry guard: `alertFamily` routes Flood Statement into the
    // Flood bucket, but without a palette entry it would render gray on
    // the map while sitting in the Flood section of the side panel. It
    // shares Flood Advisory's tone since both are Advisory-tier hydrologic
    // products, and it must rank adjacent to Flood Advisory in priority.
    expect(colorForEvent('Flood Statement')).not.toBe(FALLBACK_COLOR);
    expect(colorForEvent('Flood Statement')).toBe(colorForEvent('Flood Advisory'));
    expect(priorityForEvent('Flood Statement')).toBeGreaterThan(priorityForEvent('Flood Advisory'));
    expect(priorityForEvent('Flood Statement')).toBeLessThan(priorityForEvent('Freeze Warning'));
  });

  it('ranks warnings above watches of the same family', () => {
    expect(priorityForEvent('Tornado Warning')).toBeLessThan(priorityForEvent('Tornado Watch'));
    expect(priorityForEvent('Severe Thunderstorm Warning')).toBeLessThan(
      priorityForEvent('Severe Thunderstorm Watch'),
    );
    expect(priorityForEvent('Bogus Event')).toBe(99);
  });

  it('ranks plain Flood products just after their Flash Flood counterparts', () => {
    // Flood Warning sits right after Flash Flood Warning (same life-safety
    // band, slower onset). Watch / Advisory follow the same pattern within
    // their respective tiers. This keeps the side-panel sort stable and
    // the two water-hazard families adjacent.
    expect(priorityForEvent('Flood Warning')).toBeGreaterThan(
      priorityForEvent('Flash Flood Warning'),
    );
    expect(priorityForEvent('Flood Warning')).toBeLessThan(priorityForEvent('Tornado Watch'));
    expect(priorityForEvent('Flood Watch')).toBeGreaterThan(priorityForEvent('Flash Flood Watch'));
    expect(priorityForEvent('Flood Watch')).toBeLessThan(
      priorityForEvent('Special Weather Statement'),
    );
    expect(priorityForEvent('Flood Advisory')).toBeGreaterThan(
      priorityForEvent('Special Weather Statement'),
    );
  });

  it('ranks Freeze Warning/Watch below Special Weather Statement, Warning above Watch', () => {
    // Cold-air products are slow-onset; they should never outrank severe
    // convective products or SPS in the sort. Within the family, Warning
    // still beats Watch.
    const sws = priorityForEvent('Special Weather Statement');
    expect(priorityForEvent('Freeze Warning')).toBeGreaterThan(sws);
    expect(priorityForEvent('Freeze Watch')).toBeGreaterThan(sws);
    expect(priorityForEvent('Freeze Warning')).toBeLessThan(priorityForEvent('Freeze Watch'));
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

  it('preserves states[] on the view properties when present', () => {
    const wa = ingestToWeatherAlert(ingest({ states: ['IN', 'MI'] }));
    expect(wa.properties.states).toEqual(['IN', 'MI']);
  });

  it('leaves states undefined when the ingest record omits it', () => {
    const wa = ingestToWeatherAlert(ingest());
    expect(wa.properties.states).toBeUndefined();
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
      { nowMs: FIXTURE_NOW_MS },
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
      { nowMs: FIXTURE_NOW_MS },
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
          // STATE is the FIPS numeric string the bundled
          // `greatlakes-counties.geojson` carries on every feature. The
          // lookup keys by (state, name) to avoid cross-state collisions.
          properties: { NAME: 'Dane', STATE: '55' },
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
      { countyLookup, nowMs: FIXTURE_NOW_MS },
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
      { nowMs: FIXTURE_NOW_MS },
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
      { nowMs: FIXTURE_NOW_MS },
    );
    expect(out.listAlerts.map((a) => a.properties.event)).toEqual([
      'Tornado Warning',
      'Severe Thunderstorm Warning',
      'Tornado Watch',
    ]);
  });
});

describe('buildAlertViews — expiry grace period', () => {
  const NOW = Date.parse('2026-04-17T21:00:00Z');

  it('marks an alert expired-in-grace when past expires but within ALERT_EXPIRY_GRACE_MS', () => {
    const out = buildAlertViews(
      snap([ingest({ nws_id: 'A', expires_at: new Date(NOW - 5 * 60_000).toISOString() })]),
      { nowMs: NOW },
    );
    expect(out.listAlerts).toHaveLength(1);
    expect(out.listAlerts[0].properties.expired).toBe(true);
  });

  it('drops an alert entirely once past expires + ALERT_EXPIRY_GRACE_MS', () => {
    const out = buildAlertViews(
      snap([ingest({ nws_id: 'A', expires_at: new Date(NOW - 16 * 60_000).toISOString() })]),
      { nowMs: NOW },
    );
    expect(out.listAlerts).toHaveLength(0);
    expect(out.mapFeatures.features).toHaveLength(0);
  });

  it('does not mark a still-active alert expired', () => {
    const out = buildAlertViews(
      snap([ingest({ nws_id: 'A', expires_at: new Date(NOW + 10 * 60_000).toISOString() })]),
      { nowMs: NOW },
    );
    expect(out.listAlerts[0].properties.expired).toBe(false);
  });

  it('fails OPEN (keeps, not-expired) on an unparseable expires timestamp', () => {
    const out = buildAlertViews(snap([ingest({ nws_id: 'A', expires_at: 'not-a-timestamp' })]), {
      nowMs: NOW,
    });
    expect(out.listAlerts).toHaveLength(1);
    expect(out.listAlerts[0].properties.expired).toBe(false);
  });

  it('demotes expired-in-grace alerts below active ones regardless of tier priority', () => {
    const out = buildAlertViews(
      snap([
        ingest({
          nws_id: 'EXPIRED_TOR',
          event_type: 'Tornado Warning',
          expires_at: new Date(NOW - 5 * 60_000).toISOString(),
        }),
        ingest({
          nws_id: 'ACTIVE_WATCH',
          event_type: 'Tornado Watch',
          expires_at: new Date(NOW + 30 * 60_000).toISOString(),
        }),
      ]),
      { nowMs: NOW },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId)).toEqual(['ACTIVE_WATCH', 'EXPIRED_TOR']);
  });

  it('defaults nowMs to Date.now() when not supplied (back-compat for existing callers)', () => {
    const out = buildAlertViews(
      snap([ingest({ nws_id: 'A', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() })]),
    );
    expect(out.listAlerts[0].properties.expired).toBe(false);
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

  // Iowa coverage (2026-04-19 Phase 1). IA is the 9th state added to the
  // SeeStorm scope alongside the Great Lakes 8. These tests pin the
  // per-state filter behavior for IA alerts so a future refactor of the
  // membership set doesn't silently drop Iowa.
  it('matches Iowa alerts via area_state and cross-border states[]', () => {
    expect(alertTouchesState(ingest({ area_state: 'IA' }), 'IA')).toBe(true);
    expect(alertTouchesState(ingest({ area_state: 'ia' }), 'IA')).toBe(true);
    // Cross-border IA/IL Tornado Watch should surface for users in either state.
    expect(alertTouchesState(ingest({ area_state: 'IA', states: ['IA', 'IL'] }), 'IL')).toBe(true);
    expect(alertTouchesState(ingest({ area_state: 'IL', states: ['IA', 'IL'] }), 'IA')).toBe(true);
    // A WI-only alert should not match an IA user.
    expect(alertTouchesState(ingest({ area_state: 'WI', states: ['WI'] }), 'IA')).toBe(false);
  });
});

describe('filterAreaDescByState', () => {
  it('keeps only entries with a matching state suffix across multiple states', () => {
    const out = filterAreaDescByState('Elkhart, IN; Branch, MI; St. Joseph, MI', 'IN');
    expect(out.filtered).toBe('Elkhart, IN');
    expect(out.wasFiltered).toBe(true);
  });

  it('leaves bare county names (no state suffix) unchanged', () => {
    const out = filterAreaDescByState('Vigo; Clay; Owen', 'IN');
    expect(out.filtered).toBe('Vigo; Clay; Owen');
    expect(out.wasFiltered).toBe(false);
  });

  it('reports wasFiltered=true even when every entry already matches the state', () => {
    const out = filterAreaDescByState('Elkhart, IN', 'IN');
    expect(out.filtered).toBe('Elkhart, IN');
    expect(out.wasFiltered).toBe(true);
  });

  it('matches case-insensitively against the user state', () => {
    const out = filterAreaDescByState('Elkhart, IN; Branch, MI', 'in');
    expect(out.filtered).toBe('Elkhart, IN');
    expect(out.wasFiltered).toBe(true);
  });

  it('returns the input unchanged when userState is empty', () => {
    const out = filterAreaDescByState('Elkhart, IN; Branch, MI', '');
    expect(out.filtered).toBe('Elkhart, IN; Branch, MI');
    expect(out.wasFiltered).toBe(false);
  });

  it('falls back to the original string when filtering would yield nothing', () => {
    // Defensive: suffixes exist but none match `userState`. Rather than
    // render an empty label, return the original so the user still sees
    // SOMETHING describing the affected area.
    const out = filterAreaDescByState('Branch, MI; St. Joseph, MI', 'IN');
    expect(out.filtered).toBe('Branch, MI; St. Joseph, MI');
    expect(out.wasFiltered).toBe(false);
  });
});

describe('deriveMultiStateDisplay', () => {
  // Helper: build a minimal WeatherAlert with just the fields the derivation
  // cares about. Geometry isn't relevant — this is pure display logic.
  function view(areaDesc: string, states: string[] | undefined): WeatherAlert {
    return {
      type: 'Feature',
      geometry: null,
      properties: {
        event: 'Freeze Warning',
        headline: '',
        description: '',
        severity: '',
        urgency: '',
        effective: '',
        expires: '',
        senderName: '',
        areaDesc,
        url: null,
        nwsId: null,
        states,
      },
    };
  }

  it('returns null regionalLabel for a single-state alert', () => {
    const out = deriveMultiStateDisplay(view('Dane, WI', ['WI']), 'WI');
    expect(out.regionalLabel).toBeNull();
    expect(out.areaDesc).toBe('Dane, WI');
  });

  it('returns null regionalLabel when states is missing', () => {
    const out = deriveMultiStateDisplay(view('Dane', undefined), 'WI');
    expect(out.regionalLabel).toBeNull();
    expect(out.areaDesc).toBe('Dane');
  });

  it('uses singular "other state" when one additional state is covered', () => {
    const out = deriveMultiStateDisplay(view('Elkhart, IN; Branch, MI', ['IN', 'MI']), 'IN');
    expect(out.regionalLabel).toBe('Regional — covers IN + 1 other state');
  });

  it('uses plural "other states" when two+ additional states are covered', () => {
    const out = deriveMultiStateDisplay(
      view('Elkhart, IN; Branch, MI; Lucas, OH', ['IN', 'MI', 'OH']),
      'IN',
    );
    expect(out.regionalLabel).toBe('Regional — covers IN + 2 other states');
  });

  it('falls back to the N-states summary when userState is undefined', () => {
    const out = deriveMultiStateDisplay(
      view('Elkhart, IN; Branch, MI; Lucas, OH', ['IN', 'MI', 'OH']),
      undefined,
    );
    expect(out.regionalLabel).toBe('Regional — covers 3 states');
    // No userState ⇒ areaDesc passes through untouched.
    expect(out.areaDesc).toBe('Elkhart, IN; Branch, MI; Lucas, OH');
  });

  it('filters cross-state suffixes out of areaDesc when userState is set', () => {
    const out = deriveMultiStateDisplay(
      view('Elkhart, IN; Branch, MI; St. Joseph, MI', ['IN', 'MI']),
      'IN',
    );
    expect(out.areaDesc).toBe('Elkhart, IN');
    expect(out.regionalLabel).toBe('Regional — covers IN + 1 other state');
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

  it('treats boundary points as inside (turf default ignoreBoundary=false)', () => {
    // STUB_GEOMETRY edge: lon = -89.4 between lat 42.5..42.6 inclusive.
    // booleanPointInPolygon's documented default is to count boundary
    // points as inside; locking that down here so a future Turf upgrade
    // or an `ignoreBoundary: true` change can't silently flip behavior
    // for users whose ZIP centroid lands on a county/warning boundary.
    const onEdge = { lat: 42.55, lon: -89.4, state: 'WI' };
    expect(alertTouchesPoint(ingest(), onEdge)).toBe(true);
  });

  it('treats reverse-winding polygons identically to canonical winding', () => {
    // Same coords, traversed in opposite (clockwise vs counter-clockwise)
    // order. NWS occasionally ships either winding direction; turf's PiP
    // is winding-agnostic. Locking it down so a future "validate winding"
    // change can't drop alerts for ZIPs in correctly-shaped-but-reversed
    // polygons.
    const reversed = ingest({
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-89.5, 42.5],
            [-89.5, 42.6],
            [-89.4, 42.6],
            [-89.4, 42.5],
            [-89.5, 42.5],
          ],
        ],
      },
    });
    const inside = { lat: 42.55, lon: -89.45, state: 'WI' };
    expect(alertTouchesPoint(reversed, inside)).toBe(true);
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
      { userPoint: inside, nowMs: FIXTURE_NOW_MS },
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
      { userPoint: inside, nowMs: FIXTURE_NOW_MS },
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
      { userPoint: inside, userState: 'IL', nowMs: FIXTURE_NOW_MS }, // userState would accept; userPoint rejects
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
      { userPoint: inside, nowMs: FIXTURE_NOW_MS },
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
      { userState: 'WI', nowMs: FIXTURE_NOW_MS },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId)).toEqual(['WI1']);
  });

  it('keeps cross-border alerts whose states[] includes the user state', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'BORDER', area_state: 'IL', states: ['IL', 'WI'] }),
        ingest({ nws_id: 'IL_ONLY', area_state: 'IL', states: ['IL'] }),
      ]),
      { userState: 'WI', nowMs: FIXTURE_NOW_MS },
    );
    expect(out.listAlerts.map((a) => a.properties.nwsId)).toEqual(['BORDER']);
  });

  it('returns all alerts when no userState is set', () => {
    const out = buildAlertViews(
      snap([
        ingest({ nws_id: 'WI1', area_state: 'WI' }),
        ingest({ nws_id: 'IL1', area_state: 'IL' }),
      ]),
      { nowMs: FIXTURE_NOW_MS },
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
      { userState: 'WI', nowMs: FIXTURE_NOW_MS },
    );
    expect(out.motionAlerts.map((a) => a.nws_id)).toEqual(['WI1', 'BORDER']);
  });

  it('motionAlerts equals snapshot.alerts when no userState is set', () => {
    const input = snap([
      ingest({ nws_id: 'WI1', area_state: 'WI' }),
      ingest({ nws_id: 'IL1', area_state: 'IL' }),
    ]);
    const out = buildAlertViews(input, { nowMs: FIXTURE_NOW_MS });
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
      { nowMs: FIXTURE_NOW_MS },
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
    const out = buildAlertViews(snap([ingest({ nws_id: 'X', event_type: 'Tornado Warning' })]), {
      nowMs: FIXTURE_NOW_MS,
    });
    const groups = groupByFamily(out.listAlerts);
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe('Tornado');
  });

  it('returns empty array for zero alerts', () => {
    expect(groupByFamily([])).toEqual([]);
  });
});

describe("colorForEvent — default mode (regression: must not change today's look)", () => {
  it('returns the exact current hexes for default mode', () => {
    expect(colorForEvent('Tornado Warning')).toBe('#FF0000');
    expect(colorForEvent('Tornado Warning', 'default')).toBe('#FF0000');
    expect(colorForEvent('Severe Thunderstorm Warning', 'default')).toBe('#FFA500');
    expect(colorForEvent('Freeze Warning', 'default')).toBe('#483D8B');
  });
  it('falls back to the existing gray for unknown events in default mode', () => {
    expect(colorForEvent('Dust Storm Warning', 'default')).toBe(FALLBACK_COLOR);
  });
  it('warningColorsFor("default") is the canonical palette', () => {
    expect(warningColorsFor('default')).toBe(WARNING_COLORS);
  });
});

describe('colorForEvent — colorblind mode', () => {
  it('maps each family to its Okabe–Ito hue', () => {
    expect(colorForEvent('Tornado Warning', 'cbFriendly')).toBe('#D55E00');
    expect(colorForEvent('Tornado Watch', 'cbFriendly')).toBe('#D55E00');
    expect(colorForEvent('Severe Thunderstorm Warning', 'cbFriendly')).toBe('#E69F00');
    expect(colorForEvent('Flash Flood Warning', 'cbFriendly')).toBe('#0072B2');
    expect(colorForEvent('Flood Advisory', 'cbFriendly')).toBe('#56B4E9');
    expect(colorForEvent('Freeze Watch', 'cbFriendly')).toBe('#CC79A7');
    expect(colorForEvent('Special Weather Statement', 'cbFriendly')).toBe('#009E73');
  });
  it('uses the CB fallback for unknown events', () => {
    expect(colorForEvent('Dust Storm Warning', 'cbFriendly')).toBe(fallbackColorFor('cbFriendly'));
    expect(fallbackColorFor('cbFriendly')).toBe('#BBBBBB');
  });
});
