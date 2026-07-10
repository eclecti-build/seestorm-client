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

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint } from '@turf/helpers';
import type { ColorVisionMode } from './colorVisionMode';
import { ALERT_EXPIRY_GRACE_MS } from './constants';

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
  // Plain hydrologic Flood products (NWS "FLW" / "FLS" — river + areal flood,
  // slower onset than Flash Flood). Previously fell through to gray, which
  // read as low-urgency for a life-safety Warning. Red family so the tier is
  // unmistakable, but one step less hot than Flash Flood's dark red to
  // preserve the "flash = faster / more urgent" hierarchy. Matching Watch /
  // Advisory tones follow the 3-per-family shape used below (Watch in
  // sea-green cousin, Advisory in muted steel-blue).
  'Flood Warning': '#B22222',
  'Flood Watch': '#3CB371',
  'Flood Advisory': '#6CA6CD',
  // Flood Statement (NWS "FLS") is the status/update message attached to an
  // active Flood Warning — continues / recedes / cancels. `tierForEvent`
  // lands it in Advisory (no " Warning" / " Watch" suffix), so it shares
  // the same steel-blue tone as Flood Advisory and inherits the thinnest
  // outline + most transparent fill. Without this entry it would stay in
  // the Flood family (via `alertFamily`'s substring match) but render gray
  // on the map — an inconsistency flagged in Codex iter-2.
  'Flood Statement': '#6CA6CD',
  'Special Weather Statement': '#FFE4B5',
  // Cold-air products. Inspired by the NWS public hazards palette but nudged
  // toward cool blues/purples so they read as "cold" next to the warm severe
  // palette above. Held to Warning + Watch only — matches the 2-per-family
  // pattern already established for Tornado / Severe Thunderstorm / Flash
  // Flood, so the legend stays balanced and cold-air products don't visually
  // dominate despite being low-urgency. Cousins ("Hard Freeze Warning",
  // "Frost Advisory") intentionally fall back to gray; the icon still
  // routes them to the snowflake glyph via substring match, so the family
  // affiliation is still legible.
  'Freeze Warning': '#483D8B',
  'Freeze Watch': '#5F9EA0',
};

export const FALLBACK_COLOR = '#888888';

// Colorblind-safe palette (opt-in). One Okabe–Ito (color-universal) hue per
// product family; within-family Warning/Watch/Advisory stays encoded by the
// fill-opacity + dashed/solid stroke the map already applies, which is more
// robust for CVD than today's per-tier hue mix. Keyed by the same event
// strings as WARNING_COLORS so the selectors are symmetric.
export const WARNING_COLORS_CB: Record<string, string> = {
  'Tornado Warning': '#D55E00',
  'Tornado Watch': '#D55E00',
  'Severe Thunderstorm Warning': '#E69F00',
  'Severe Thunderstorm Watch': '#E69F00',
  'Flash Flood Warning': '#0072B2',
  'Flash Flood Watch': '#0072B2',
  'Flood Warning': '#56B4E9',
  'Flood Watch': '#56B4E9',
  'Flood Advisory': '#56B4E9',
  'Flood Statement': '#56B4E9',
  'Special Weather Statement': '#009E73',
  'Freeze Warning': '#CC79A7',
  'Freeze Watch': '#CC79A7',
};

export const FALLBACK_COLOR_CB = '#BBBBBB';

export function warningColorsFor(mode: ColorVisionMode): Record<string, string> {
  return mode === 'cbFriendly' ? WARNING_COLORS_CB : WARNING_COLORS;
}

export function fallbackColorFor(mode: ColorVisionMode): string {
  return mode === 'cbFriendly' ? FALLBACK_COLOR_CB : FALLBACK_COLOR;
}

export const WARNING_PRIORITY: Record<string, number> = {
  'Tornado Warning': 0,
  'Severe Thunderstorm Warning': 1,
  'Flash Flood Warning': 2,
  // Plain Flood Warning sits immediately after Flash Flood Warning in the
  // warning band — same life-safety tier, slower onset.
  'Flood Warning': 2.5,
  'Tornado Watch': 3,
  'Severe Thunderstorm Watch': 4,
  'Flash Flood Watch': 5,
  'Flood Watch': 5.5,
  'Special Weather Statement': 6,
  'Flood Advisory': 6.5,
  // FLS rides with Flood Advisory — same Advisory tier, same hydrologic
  // family, just a message product rather than a new threat tier.
  'Flood Statement': 6.6,
  // Cold-air products rank below SPS — non-life-threatening, slow-onset.
  // Matches the 2-per-family shape of the severe palette above.
  'Freeze Warning': 7,
  'Freeze Watch': 8,
};

export function colorForEvent(event: string, mode: ColorVisionMode = 'default'): string {
  return warningColorsFor(mode)[event] ?? fallbackColorFor(mode);
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

export type AlertFamily = 'Tornado' | 'Severe Thunderstorm' | 'Flash Flood' | 'Flood' | 'Other';

/**
 * Map an NWS event string to a coarse product family so the side panel can
 * group related watches + warnings together. Substring match lets new
 * variants (e.g. "Tornado Emergency") group under the expected family
 * without code changes.
 *
 * Order matters: 'Flash Flood' must be checked before 'Flood' so "Flash
 * Flood Warning" doesn't collapse into the slower-onset Flood family. These
 * are distinct NWS product lines (rapid vs. areal/river) and should stay
 * visually separate in the side panel.
 */
export function alertFamily(event: string): AlertFamily {
  if (event.includes('Tornado')) return 'Tornado';
  if (event.includes('Severe Thunderstorm')) return 'Severe Thunderstorm';
  if (event.includes('Flash Flood')) return 'Flash Flood';
  if (event.includes('Flood')) return 'Flood';
  return 'Other';
}

export const FAMILY_ORDER: readonly AlertFamily[] = [
  'Tornado',
  'Severe Thunderstorm',
  'Flash Flood',
  // Plain hydrologic Flood products (Flood Warning / Watch / Advisory) —
  // slower onset than Flash Flood, but still a life-safety warning. Ordered
  // directly after Flash Flood so the two water-hazard families sit
  // together in the side panel.
  'Flood',
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
import {
  type TornadoDetection,
  type TornadoCategory,
  asTornadoDetection,
  tornadoCategory,
  tornadoColor,
  tornadoLabel,
  tornadoLabelTitle,
  tornadoMapAnnotation,
} from './tornado';
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
  // v2 schema additions — multi-state coverage.
  // `area_state` is the primary state code (USPS 2-letter, e.g. "WI") when the
  // alert is single-state; null when ingest cannot determine a primary.
  // `states` is the full set of state codes the alert touches (e.g. for a
  // cross-border Tornado Watch). Both are optional/additive so legacy v1
  // snapshots (single-state) deserialize unchanged.
  area_state?: string | null;
  states?: string[];
  // Additive (no schema bump): the normalized tornado detection axis
  // derived by ingest. Absent for every non-tornado product. See umbrella
  // docs/TORNADO_DETECTION_CONTRACT.md.
  tornado?: TornadoDetection | null;
}

/**
 * Ingest snapshot. Schema v2 (multi-state) carries:
 *   - `schema_version: 2`
 *   - `areas: string[]` (replaces v1's single `area: string`)
 *
 * v1 snapshots (no `schema_version`, scalar `area`) are still accepted via the
 * `parseIngestSnapshot` coercion helper. Anything with `schema_version` set to
 * a value other than 2 is rejected to surface contract drift early.
 */
export interface IngestSnapshot {
  generated_at: string;
  /**
   * Epoch-ms copy of `generated_at`, populated by ingest ≥ 44caae5
   * (swarm audit 2026-04-18, Tier 1 #2b). Used for clock-skew calibration
   * and the staleness banner without re-parsing the ISO string on every
   * poll. Optional because older snapshots (pre-44caae5) and history
   * fixtures may not include it — consumers should fall back gracefully.
   */
  generated_at_ms?: number;
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

  // generated_at_ms is additive — ingest ≥ 44caae5 ships it, older payloads
  // don't. Accept only finite positive numbers; fall through to `undefined`
  // otherwise so downstream consumers (clock-offset hook, StalenessBanner)
  // can detect absence and degrade cleanly instead of crunching NaN.
  const genMsRaw = obj.generated_at_ms;
  const generatedAtMs =
    typeof genMsRaw === 'number' && Number.isFinite(genMsRaw) && genMsRaw > 0
      ? genMsRaw
      : undefined;

  return {
    generated_at: obj.generated_at,
    generated_at_ms: generatedAtMs,
    areas,
    alert_count: typeof obj.alert_count === 'number' ? obj.alert_count : alerts.length,
    alerts,
    schema_version: typeof schemaVersion === 'number' ? schemaVersion : undefined,
  };
}

/**
 * Resolve the timestamp used to render expiry-sensitive alert views.
 * Historical snapshots render against their own generated time; live
 * snapshots keep the caller-provided clock.
 */
export function resolveViewNowMs(
  snapshot: IngestSnapshot,
  nowMs: number | undefined,
  useSnapshotTimeAsNow: boolean | undefined,
): number | undefined {
  return useSnapshotTimeAsNow &&
    snapshot.generated_at_ms &&
    Number.isFinite(snapshot.generated_at_ms)
    ? snapshot.generated_at_ms
    : useSnapshotTimeAsNow
      ? Date.parse(snapshot.generated_at)
      : nowMs;
}

/**
 * Server-anchored clock for the expiry-DROP decision in `buildAlertViews`.
 *
 * Dropping an alert is irreversible for the user (it vanishes from map and
 * panel), so the clock it's judged against must not be influenced by the
 * client's wall clock: a >grace-period-fast local clock would otherwise
 * silently remove LIVE alerts whenever clock calibration is unavailable
 * (payloads without `generated_at_ms`, or the first fetch of a session
 * before `useClockOffset` has calibrated) — the Tier 1 fast-follow.
 * The snapshot's own generated time is server truth and is always ≤ the
 * true current time, so judging `expires + grace` against it can only drop
 * LATE (by cache age + poll interval, ≪ the 15-min grace), never early.
 * Returns `null` when the snapshot carries no parseable time at all —
 * callers must then fail open and not drop. The cosmetic dim/badge path
 * (`isExpiredInGrace`) deliberately stays on the caller's `nowMs`: a wrong
 * badge is recoverable, a wrong drop is not.
 */
export function resolveDropNowMs(snapshot: IngestSnapshot): number | null {
  const genMs = snapshot.generated_at_ms;
  if (typeof genMs === 'number' && Number.isFinite(genMs) && genMs > 0) {
    return genMs;
  }
  const parsed = Date.parse(snapshot.generated_at);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  /**
   * Full set of USPS 2-letter state codes the underlying ingest record
   * marked this alert as touching. Optional/additive — legacy v1 snapshots
   * and alerts that ingest couldn't tag will omit it. Used by the UI to
   * badge multi-state NWS products (Freeze Warnings, river Floods, etc.)
   * so users understand cross-border scope.
   */
  states?: string[];
  /**
   * Tornado detection axis. `tornado` is the structured object (used by
   * the side panel, which holds the real WeatherAlert object). The flat
   * fields are denormalized onto the GeoJSON feature properties so
   * MapLibre layer filters and the click-popup can read them WITHOUT
   * tripping the nested-object stringification gotcha (queried features
   * JSON-stringify nested props). All optional/additive.
   */
  tornado?: TornadoDetection | null;
  tornadoConfirmed?: boolean;
  /** Normalized single category — the stateful ladder, not a compound. */
  tornadoCategory?: TornadoCategory;
  /** Category color (magenta-ramp); drives label + parallel map layers. */
  tornadoColor?: string;
  /** Pre-rendered single label, e.g. "Tornado Warning — Confirmed". */
  tornadoLabel?: string;
  /** Spelled-out tooltip for the label (e.g. PDS expansion). */
  tornadoLabelTitle?: string;
  /** On-map call-to-action; only set when confirmed. */
  tornadoAnnotation?: string;
  expired?: boolean;
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
      // Pass the full state set through to the view layer so the side panel
      // can badge multi-state products. Copied defensively to keep the view
      // shape independent of the ingest object's reference.
      states: Array.isArray(a.states) ? [...a.states] : undefined,
      // Tornado detection: narrow the loosely-cast snapshot field, then
      // denormalize to flat primitives for map filters / the click popup.
      // `tornado` (object) is kept for the side panel; the flat fields are
      // what MapLibre and the queried-feature popup actually read.
      ...tornadoProps(a.event_type, asTornadoDetection(a.tornado)),
    },
    geometry: a.geometry,
  };
}

/**
 * Compute the flat tornado feature properties from a narrowed detection.
 * Returns an empty object when there is no detection so non-tornado
 * features carry no tornado keys at all (smaller features, simpler
 * filters: `['==', ['get','tornadoConfirmed'], true]` is naturally false).
 */
function tornadoProps(
  eventType: string,
  d: TornadoDetection | null,
): Partial<WeatherAlertProperties> {
  if (!d) return {};
  return {
    tornado: d,
    tornadoConfirmed: d.confirmed,
    tornadoCategory: tornadoCategory(d),
    tornadoColor: tornadoColor(d),
    tornadoLabel: tornadoLabel(eventType, d),
    tornadoLabelTitle: tornadoLabelTitle(d),
    tornadoAnnotation: tornadoMapAnnotation(d) || undefined,
  };
}

/**
 * Display-only helper for multi-state NWS products. When `areaDesc` contains
 * at least one entry with a `, XX` state suffix, keep only the entries whose
 * suffix matches `userState` and return `wasFiltered: true`. When no entries
 * carry a state suffix (bare county names), return the input unchanged — we
 * can't safely infer state without a zone→state map.
 *
 * The filter is purely cosmetic: `alertTouchesState` still decides whether
 * an alert is shown at all. This just trims the rendered county list so a
 * user in Indiana doesn't see a Freeze Warning listing Michigan counties.
 */
export function filterAreaDescByState(
  areaDesc: string,
  userState: string,
): { filtered: string; wasFiltered: boolean } {
  if (!userState) return { filtered: areaDesc, wasFiltered: false };

  const parts = areaDesc.split(';').map((p) => p.trim());
  const suffixRe = /, ([A-Z]{2})$/;
  const anyHasSuffix = parts.some((p) => suffixRe.test(p));
  if (!anyHasSuffix) return { filtered: areaDesc, wasFiltered: false };

  const target = userState.toUpperCase();
  const kept = parts.filter((p) => {
    const m = p.match(suffixRe);
    return m !== null && m[1].toUpperCase() === target;
  });

  // Defensive: if filtering yielded nothing (user state didn't match any
  // suffix in the listing — shouldn't happen when the alert already passed
  // `alertTouchesState`, but guard so we never render an empty label), fall
  // back to the original string.
  if (kept.length === 0) return { filtered: areaDesc, wasFiltered: false };

  return { filtered: kept.join('; '), wasFiltered: true };
}

/**
 * Derive the display-only `areaDesc` + regional-coverage label for an alert
 * card / popup. Centralizes the logic that both AlertsPanel's AlertCard and
 * WeatherMap's selected-alert popup used to duplicate inline, so they can
 * never drift.
 *
 * Pure: no React, no DOM. Returns:
 *   - `areaDesc` — when `userState` is set, the county list trimmed via
 *     `filterAreaDescByState`; otherwise the raw `areaDesc` unchanged.
 *   - `regionalLabel` — null for single-state alerts (or when `states` is
 *     missing); otherwise a short "Regional — covers …" badge string.
 */
export function deriveMultiStateDisplay(
  alert: WeatherAlert,
  userState: string | undefined,
): { areaDesc: string; regionalLabel: string | null } {
  const areaDesc = userState
    ? filterAreaDescByState(alert.properties.areaDesc, userState).filtered
    : alert.properties.areaDesc;

  const states = alert.properties.states;
  if (!Array.isArray(states) || states.length <= 1) {
    return { areaDesc, regionalLabel: null };
  }

  let regionalLabel: string;
  if (userState) {
    const others = states.length - 1;
    regionalLabel = `Regional — covers ${userState.toUpperCase()} + ${others} other ${
      others === 1 ? 'state' : 'states'
    }`;
  } else {
    regionalLabel = `Regional — covers ${states.length} states`;
  }
  return { areaDesc, regionalLabel };
}

function byPriority(a: WeatherAlert, b: WeatherAlert): number {
  return priorityForEvent(a.properties.event) - priorityForEvent(b.properties.event);
}

export function isPastGracePeriod(
  expiresIso: string,
  nowMs: number,
  graceMs: number = ALERT_EXPIRY_GRACE_MS,
): boolean {
  const expiresMs = Date.parse(expiresIso);
  if (!Number.isFinite(expiresMs)) return false;
  return nowMs - expiresMs > graceMs;
}

export function isExpiredInGrace(
  expiresIso: string,
  nowMs: number,
  graceMs: number = ALERT_EXPIRY_GRACE_MS,
): boolean {
  const expiresMs = Date.parse(expiresIso);
  if (!Number.isFinite(expiresMs)) return false;
  return nowMs > expiresMs && nowMs - expiresMs <= graceMs;
}

/**
 * True once an alert has expired, with no upper bound: badge, dimming, and
 * sort demotion must remain sticky when the snapshot-anchored drop clock has
 * not aged the alert out yet, such as during a stale live feed.
 */
export function isPastExpiry(expiresIso: string, nowMs: number): boolean {
  const expiresMs = Date.parse(expiresIso);
  if (!Number.isFinite(expiresMs)) return false;
  return nowMs > expiresMs;
}

function byExpiryThenPriority(nowMs: number) {
  return (a: WeatherAlert, b: WeatherAlert): number => {
    const aExpired = isPastExpiry(a.properties.expires, nowMs) ? 1 : 0;
    const bExpired = isPastExpiry(b.properties.expires, nowMs) ? 1 : 0;
    if (aExpired !== bExpired) return aExpired - bExpired;
    return byPriority(a, b);
  };
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
/**
 * True when the alert's polygon contains the user's coordinates, OR — for
 * zone-only alerts (no polygon geometry) — when the alert touches the user's
 * state. This lets us deliver pixel-precise filtering for the urgent
 * polygon-bearing products (Tornado / Severe Thunderstorm / Flash Flood
 * Warnings) while still surfacing broad zone-aggregate products (Watches,
 * statewide Advisories) that affect the user's region but cover too large
 * an area to have a polygon.
 *
 * The polygon path uses `@turf/boolean-point-in-polygon` and accepts both
 * Polygon and MultiPolygon geometries (NWS commonly ships MultiPolygon for
 * disjoint warning footprints). GeometryCollection and unsupported types
 * fall through to the state-level fallback rather than throwing — defensive
 * because malformed upstream geometry shouldn't blank the alert feed.
 */
export function alertTouchesPoint(
  alert: IngestAlert,
  userPoint: { lat: number; lon: number; state: string },
): boolean {
  const geom = alert.geometry;
  // Zone-only alert (no geometry) — expected for Watches and broad
  // Advisories. Fall through silently to the state-level match; this is
  // the documented degradation path, not a degraded scenario.
  if (geom === null || geom === undefined) {
    return alertTouchesState(alert, userPoint.state);
  }
  if (typeof geom === 'object' && 'type' in geom) {
    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      try {
        return booleanPointInPolygon(turfPoint([userPoint.lon, userPoint.lat]), geom);
      } catch (err) {
        // Malformed coordinates / non-finite values: log so we can spot
        // upstream regressions in NWS payload quality, then fall back to
        // the state-level filter. This is fail-OPEN by design — a public
        // safety product should over-show a relevant warning rather than
        // hide it because of one bad coordinate. The log surface lets
        // operators see in CF analytics if upstream geometry quality
        // degrades.
        console.warn(
          '[alerts] alertTouchesPoint: PiP failed for alert',
          alert.nws_id,
          '— falling back to state match',
          err,
        );
        return alertTouchesState(alert, userPoint.state);
      }
    }
    // Unsupported geometry type on an alert that DOES carry geometry —
    // not the Watch case (handled above). NWS warning products ship
    // Polygon/MultiPolygon by spec; anything else is a payload regression.
    // Log and fall back to state, same fail-open posture as the malformed
    // case above.
    console.warn(
      '[alerts] alertTouchesPoint: unsupported geometry type',
      geom.type,
      'for alert',
      alert.nws_id,
      '— falling back to state match',
    );
  }
  return alertTouchesState(alert, userPoint.state);
}

export function alertTouchesState(alert: IngestAlert, userState: string): boolean {
  const target = userState.toUpperCase();
  const hasAreaState = typeof alert.area_state === 'string' && alert.area_state.length > 0;
  // `states: []` is treated the same as a missing field. Ingest emits an
  // empty array for zone-aggregate products (e.g. some Flood Watches) when
  // per-alert state derivation fails. Those alerts still have a real
  // `area_desc` covering the user's state, so dropping them silently hides
  // live safety products — the fail-safe choice is to let them through and
  // rely on the snapshot-level `areas` to bound scope.
  const hasStates = Array.isArray(alert.states) && alert.states.length > 0;

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

  // No usable state metadata (legacy v1 record, or v2 record with empty
  // states[] and no area_state): can't filter safely, so let it through.
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
     *
     * `userPoint` (when also set) takes precedence — the chip-level state
     * pick is the coarse fallback while the ZIP-level point is the precise
     * filter.
     */
    userState?: string;
    /**
     * When set, restrict to alerts whose polygon contains this point. Falls
     * back to state-level matching for zone-only alerts (no polygon — e.g.
     * Watches, broad Advisories), so the user still sees statewide products
     * that affect their region. Takes precedence over `userState` when both
     * are provided. Caller is responsible for hydrating this from a saved
     * ZIP record (lat/lon/state).
     */
    userPoint?: { lat: number; lon: number; state: string };
    /**
     * USPS 2-letter codes used when synthesizing geometry from `area_desc`
     * for zone-only alerts. Defaults to the snapshot's `areas` (so a
     * multi-state v2 snapshot resolves multi-state county names without
     * extra wiring). Callers can override to narrow further.
     */
    allowedStates?: readonly string[];
    nowMs?: number;
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
  const { countyLookup, userState, userPoint, allowedStates, nowMs = Date.now() } = options;
  // Choose state filter for area_desc parsing. If the caller didn't pass one,
  // fall back to whatever the snapshot says it covers — for multi-state v2
  // snapshots this naturally lets cross-border watches hydrate against any
  // covered state's counties.
  const resolvedAllowed: readonly string[] | undefined =
    allowedStates ?? (snapshot.areas.length > 0 ? snapshot.areas : undefined);

  const dropNowMs = resolveDropNowMs(snapshot);

  // Filter precedence: userPoint (precise, ZIP-derived) wins over userState
  // (coarse, picker-derived). Both are optional — when neither is set,
  // every alert in the snapshot is included.
  const filteredIngest = (
    userPoint
      ? snapshot.alerts.filter((a) => alertTouchesPoint(a, userPoint))
      : userState
        ? snapshot.alerts.filter((a) => alertTouchesState(a, userState))
        : snapshot.alerts
  ).filter((a) => dropNowMs === null || !isPastGracePeriod(a.expires_at, dropNowMs));

  const allAlerts = filteredIngest
    .map((a) => {
      const alert = ingestToWeatherAlert(a);
      alert.properties.expired = isPastExpiry(a.expires_at, nowMs);
      return alert;
    })
    .sort(byExpiryThenPriority(nowMs));
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
