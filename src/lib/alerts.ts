// Shared alert types, categorization, and snapshot transforms.
//
// Kept pure (no React, no MapLibre, no fetch) so unit tests can exercise the
// full data path without a DOM or network. WeatherMap.tsx and AlertsPanel.tsx
// both consume `buildAlertViews`:
//   - the side panel gets every alert so county-wide watches without polygons
//     still show up in the UI;
//   - the map gets geometry-bearing alerts directly, PLUS any zone-only alerts
//     whose `area_desc` county names could be resolved against the bundled
//     county GeoJSON (see `countyGeometry.ts`). This keeps Tornado Watches
//     visible on the map as multi-county fills even though NWS ships them
//     without polygon geometry.

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const WARNING_COLORS: Record<string, string> = {
  'Tornado Warning': '#FF0000',
  'Tornado Watch': '#FFFF00',
  'Severe Thunderstorm Warning': '#FFA500',
  'Severe Thunderstorm Watch': '#DB7093',
  'Flash Flood Warning': '#8B0000',
  'Flash Flood Watch': '#2E8B57',
  'Special Weather Statement': '#FFE4B5',
};

export const FALLBACK_COLOR = '#888888';

export const WARNING_PRIORITY: Record<string, number> = {
  'Tornado Warning': 0,
  'Severe Thunderstorm Warning': 1,
  'Flash Flood Warning': 2,
  'Tornado Watch': 3,
  'Severe Thunderstorm Watch': 4,
  'Flash Flood Watch': 5,
  'Special Weather Statement': 6,
};

export function colorForEvent(event: string): string {
  return WARNING_COLORS[event] ?? FALLBACK_COLOR;
}

export function priorityForEvent(event: string): number {
  return WARNING_PRIORITY[event] ?? 99;
}

// ---------------------------------------------------------------------------
// Tiering + family categorization
// ---------------------------------------------------------------------------

export type AlertTier = 'Warning' | 'Watch' | 'Advisory';

export function tierForEvent(event: string): AlertTier {
  if (event.endsWith(' Warning')) return 'Warning';
  if (event.endsWith(' Watch')) return 'Watch';
  return 'Advisory';
}

export type AlertFamily = 'Tornado' | 'Severe Thunderstorm' | 'Flash Flood' | 'Other';

/**
 * Map an NWS event string to a coarse product family so the side panel can
 * group related watches + warnings together. Substring match lets new
 * variants (e.g. "Tornado Emergency") group under the expected family
 * without code changes.
 */
export function alertFamily(event: string): AlertFamily {
  if (event.includes('Tornado')) return 'Tornado';
  if (event.includes('Severe Thunderstorm')) return 'Severe Thunderstorm';
  if (event.includes('Flash Flood')) return 'Flash Flood';
  return 'Other';
}

export const FAMILY_ORDER: readonly AlertFamily[] = [
  'Tornado',
  'Severe Thunderstorm',
  'Flash Flood',
  'Other',
];

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

/**
 * Return the best outbound URL for an alert:
 *   1. Ingest-provided `url` (NWS CAP/ATOM feed link) if present.
 *   2. Deterministic fallback derived from `nws_id` via the public
 *      weather.gov API endpoint — stable, no auth, always resolvable.
 *   3. null when neither is available (UI hides the link).
 */
export function resolveAlertUrl(params: {
  url?: string | null;
  nws_id?: string | null;
}): string | null {
  if (typeof params.url === 'string' && params.url.length > 0) return params.url;
  if (typeof params.nws_id === 'string' && params.nws_id.length > 0) {
    return `https://api.weather.gov/alerts/${encodeURIComponent(params.nws_id)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ingest + view contracts
// ---------------------------------------------------------------------------

import type { StormMotion } from './stormMotion';
import { synthesizeGeometryFromAreaDesc, type CountyLookup } from './countyGeometry';

// Ingest snapshot shape (from seestorm-ingest internal/publisher.Snapshot).
// `url` is optional/additive — older snapshots without it still flow through
// and fall back to the nws_id-derived URL in `resolveAlertUrl`.
export interface IngestAlert {
  nws_id: string;
  event_type: string;
  severity: string;
  headline: string;
  description: string;
  area_desc: string;
  geometry: GeoJSON.Geometry | null;
  effective_at: string;
  expires_at: string;
  url?: string | null;
  storm_motion?: StormMotion | null;
  // v2 schema additions — multi-state Great Lakes coverage.
  // `area_state` is the primary state code (USPS 2-letter, e.g. "WI") when the
  // alert is single-state; null when ingest cannot determine a primary.
  // `states` is the full set of state codes the alert touches (e.g. for a
  // cross-border Tornado Watch). Both are optional/additive so legacy v1
  // snapshots (single-state Wisconsin) deserialize unchanged.
  area_state?: string | null;
  states?: string[];
}

/**
 * Ingest snapshot. Schema v2 (multi-state Great Lakes) carries:
 *   - `schema_version: 2`
 *   - `areas: string[]` (replaces v1's single `area: string`)
 *
 * v1 snapshots (no `schema_version`, scalar `area`) are still accepted via the
 * `parseIngestSnapshot` coercion helper. Anything with `schema_version` set to
 * a value other than 2 is rejected to surface contract drift early.
 */
export interface IngestSnapshot {
  generated_at: string;
  areas: string[];
  alert_count: number;
  alerts: IngestAlert[];
  schema_version?: number;
}

/**
 * Coerce a raw JSON payload from `/v1/active-events.json` (or the history
 * endpoint) into an IngestSnapshot. Accepts both v1 (legacy single-state) and
 * v2 (multi-state) shapes; throws on a future schema version we don't
 * understand so the caller can surface a clear error instead of rendering an
 * empty / wrong map.
 *
 * Kept in this module so tests can exercise the version negotiation without a
 * fetch mock.
 */
export function parseIngestSnapshot(raw: unknown): IngestSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Snapshot is not an object');
  }
  const obj = raw as Record<string, unknown>;

  const schemaVersion = obj.schema_version;
  if (schemaVersion !== undefined) {
    if (typeof schemaVersion !== 'number' || schemaVersion !== 2) {
      throw new Error(`Unsupported snapshot schema_version: ${String(schemaVersion)} (expected 2)`);
    }
  }

  // Accept v2 `areas: string[]` directly; coerce v1 scalar `area: string` →
  // `["WI"]`. Anything else is malformed.
  let areas: string[];
  if (Array.isArray(obj.areas)) {
    areas = obj.areas.filter((a): a is string => typeof a === 'string');
  } else if (typeof obj.area === 'string') {
    areas = [obj.area];
  } else {
    areas = [];
  }

  if (typeof obj.generated_at !== 'string') {
    throw new Error('Snapshot missing generated_at');
  }
  if (!Array.isArray(obj.alerts)) {
    throw new Error('Snapshot missing alerts array');
  }
  const alerts = obj.alerts as IngestAlert[];

  return {
    generated_at: obj.generated_at,
    areas,
    alert_count: typeof obj.alert_count === 'number' ? obj.alert_count : alerts.length,
    alerts,
    schema_version: typeof schemaVersion === 'number' ? schemaVersion : undefined,
  };
}

// Map-internal shape. `url` + `nwsId` are always present on the shape (null
// when we have nothing to point at) so downstream code can do a single
// nullish check instead of switching on schema version.
export interface WeatherAlertProperties {
  event: string;
  headline: string;
  description: string;
  severity: string;
  urgency: string;
  effective: string;
  expires: string;
  senderName: string;
  areaDesc: string;
  url: string | null;
  nwsId: string | null;
}

export interface WeatherAlert {
  type: 'Feature';
  properties: WeatherAlertProperties;
  geometry: GeoJSON.Geometry | null;
}

export interface AlertsResponse {
  type: 'FeatureCollection';
  features: WeatherAlert[];
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export function ingestToWeatherAlert(a: IngestAlert): WeatherAlert {
  return {
    type: 'Feature',
    properties: {
      event: a.event_type,
      headline: a.headline,
      description: a.description,
      severity: a.severity,
      urgency: '',
      effective: a.effective_at,
      expires: a.expires_at,
      senderName: '',
      areaDesc: a.area_desc,
      url: resolveAlertUrl({ url: a.url, nws_id: a.nws_id }),
      nwsId: a.nws_id || null,
    },
    geometry: a.geometry,
  };
}

function byPriority(a: WeatherAlert, b: WeatherAlert): number {
  return priorityForEvent(a.properties.event) - priorityForEvent(b.properties.event);
}

/**
 * Split one ingest snapshot into:
 *   - `mapFeatures` — FeatureCollection suitable for MapLibre's alerts source.
 *                     Polygon-bearing alerts pass through unchanged. When a
 *                     `countyLookup` is supplied, zone-only alerts (geometry
 *                     === null) get a synthesized MultiPolygon built from
 *                     their `area_desc` county names; if nothing resolves,
 *                     they stay off the map.
 *   - `listAlerts`  — every alert (with or without geometry), sorted by
 *                     priority. Feeds the side panel so zone-only alerts
 *                     stay visible even when hydration misses.
 */
/**
 * True when the alert touches `userState`. v2 snapshots carry both `area_state`
 * (primary) and `states[]` (full set) on each alert — match either. v1
 * single-state snapshots carry no state metadata, so this returns true (no
 * filtering possible). Callers can also supply `cross` = the full set of
 * snapshot states to broaden matching when nothing else resolves (e.g. accept
 * any alert in the snapshot when ingest didn't tag the alert at all).
 */
export function alertTouchesState(alert: IngestAlert, userState: string): boolean {
  const target = userState.toUpperCase();
  const hasAreaState = typeof alert.area_state === 'string' && alert.area_state.length > 0;
  const hasStates = Array.isArray(alert.states);

  // If EITHER metadata field is present, this is a v2 record and we apply
  // strict matching. The two fields are union-OR'd: a cross-border alert
  // tagged `area_state: "IL"` with `states: ["IL", "WI"]` matches both.
  if (hasAreaState || hasStates) {
    if (hasAreaState && alert.area_state!.toUpperCase() === target) return true;
    if (hasStates) {
      for (const s of alert.states!) {
        if (typeof s === 'string' && s.toUpperCase() === target) return true;
      }
    }
    return false;
  }

  // No state metadata on this alert (legacy v1 record): can't filter, so let it through.
  return true;
}

export function buildAlertViews(
  snapshot: IngestSnapshot,
  options: {
    countyLookup?: CountyLookup;
    /**
     * When set, restrict both `mapFeatures` and `listAlerts` to alerts that
     * touch this state (USPS 2-letter, e.g. "WI"). Cross-border alerts whose
     * `states[]` includes the user's state are kept. When unset, every alert
     * in the snapshot is included.
     */
    userState?: string;
    /**
     * USPS 2-letter codes used when synthesizing geometry from `area_desc`
     * for zone-only alerts. Defaults to the snapshot's `areas` (so a
     * multi-state v2 snapshot resolves multi-state county names without
     * extra wiring). Callers can override to narrow further.
     */
    allowedStates?: readonly string[];
  } = {},
): {
  mapFeatures: AlertsResponse;
  listAlerts: WeatherAlert[];
  /**
   * The filtered raw `IngestAlert[]` (same userState scoping applied to
   * `mapFeatures`/`listAlerts`). Exposed so callers that need the original
   * shape — e.g. the storm-motion arrow renderer — can apply the same
   * filter without reproducing the predicate. If the snapshot is rendered
   * unfiltered (no `userState`), this is identical to `snapshot.alerts`.
   */
  motionAlerts: IngestAlert[];
} {
  const { countyLookup, userState, allowedStates } = options;
  // Choose state filter for area_desc parsing. If the caller didn't pass one,
  // fall back to whatever the snapshot says it covers — for multi-state v2
  // snapshots this naturally lets cross-border watches hydrate against any
  // covered state's counties.
  const resolvedAllowed: readonly string[] | undefined =
    allowedStates ?? (snapshot.areas.length > 0 ? snapshot.areas : undefined);

  const filteredIngest = userState
    ? snapshot.alerts.filter((a) => alertTouchesState(a, userState))
    : snapshot.alerts;

  const allAlerts = filteredIngest.map(ingestToWeatherAlert).sort(byPriority);
  const mapAlerts: WeatherAlert[] = [];
  for (const alert of allAlerts) {
    if (alert.geometry !== null) {
      mapAlerts.push(alert);
      continue;
    }
    if (!countyLookup) continue;
    const synthesized = synthesizeGeometryFromAreaDesc(
      alert.properties.areaDesc,
      countyLookup,
      resolvedAllowed ? { allowedStates: resolvedAllowed } : undefined,
    );
    if (synthesized) mapAlerts.push({ ...alert, geometry: synthesized });
  }
  return {
    mapFeatures: { type: 'FeatureCollection', features: mapAlerts },
    listAlerts: allAlerts,
    motionAlerts: filteredIngest,
  };
}

/**
 * Group alerts by family, returning `FAMILY_ORDER` first, only non-empty
 * families included. Within each family, alerts keep their pre-sort (priority)
 * order from `buildAlertViews`.
 */
export function groupByFamily(
  alerts: readonly WeatherAlert[],
): Array<{ family: AlertFamily; alerts: WeatherAlert[] }> {
  const buckets = new Map<AlertFamily, WeatherAlert[]>();
  for (const a of alerts) {
    const fam = alertFamily(a.properties.event);
    const bucket = buckets.get(fam);
    if (bucket) bucket.push(a);
    else buckets.set(fam, [a]);
  }
  return FAMILY_ORDER.filter((f) => buckets.has(f)).map((family) => ({
    family,
    alerts: buckets.get(family) ?? [],
  }));
}
