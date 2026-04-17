// Shared alert types, categorization, and snapshot transforms.
//
// Kept pure (no React, no MapLibre, no fetch) so unit tests can exercise the
// full data path without a DOM or network. WeatherMap.tsx and AlertsPanel.tsx
// both consume `buildAlertViews` — the map gets only geometry-bearing alerts
// (so polygons render correctly), the side panel gets every alert (so
// county-wide watches without polygons still show up in the UI).

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
}

export interface IngestSnapshot {
  generated_at: string;
  area: string;
  alert_count: number;
  alerts: IngestAlert[];
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
 *                     Only alerts with geometry are included; they're the ones
 *                     that can render as polygons. Same contract the map has
 *                     always had — the polygon render path is untouched.
 *   - `listAlerts`  — every alert (with or without geometry), sorted by
 *                     priority. Feeds the side panel so county-wide watches
 *                     without polygons stay visible to the user.
 */
export function buildAlertViews(snapshot: IngestSnapshot): {
  mapFeatures: AlertsResponse;
  listAlerts: WeatherAlert[];
} {
  const allAlerts = snapshot.alerts.map(ingestToWeatherAlert).sort(byPriority);
  const mapAlerts = allAlerts.filter((a) => a.geometry !== null);
  return {
    mapFeatures: { type: 'FeatureCollection', features: mapAlerts },
    listAlerts: allAlerts,
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
