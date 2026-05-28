// Pure helpers for hydrating zone-only alerts (e.g. Tornado Watches) with
// synthesized polygon geometry. NWS issues Watches as county-wide products
// with no polygon — only `area_desc` and sometimes UGC codes. Until the
// ingest contract carries structured UGC, we parse `area_desc` county names
// and union the matching county polygons from the bundled
// per-state county GeoJSON files in `public/geo/counties/`.
//
// The lookup is keyed by (state, name) because county names repeat across
// states — `Washington` alone exists in IA, MN, NY, OH, PA, WI, etc., and
// `Monroe` exists in 6 of our covered states. A name-only lookup silently
// overwrites duplicates, which would hydrate the wrong-state polygon for
// zone-only alerts.
//
// Kept pure (no React, no fetch) so unit tests cover the full path.

import { fipsToUsps } from './stateFips';

export type CountyLookup = (name: string, state: string) => GeoJSON.MultiPolygon | null;

/**
 * Build a case-insensitive (state, county-name) → MultiPolygon lookup from a
 * bundled counties FeatureCollection. Each feature must carry both `NAME` and
 * `STATE` (FIPS numeric string) properties — features missing either, or with
 * a STATE code outside SeeStorm's covered-states map, are skipped. Polygon
 * geometries are promoted to single-member MultiPolygons so callers have a
 * uniform shape.
 *
 * The returned lookup takes a USPS state code (e.g. `'WI'`), matching what
 * `parseCountyNamesFromAreaDesc` emits after parsing `area_desc`.
 */
export function buildCountyLookup(fc: GeoJSON.FeatureCollection): CountyLookup {
  const byKey = new Map<string, GeoJSON.MultiPolygon>();
  for (const feature of fc.features) {
    const props = feature.properties;
    const name = props && typeof props.NAME === 'string' ? props.NAME : null;
    const fips = props && typeof props.STATE === 'string' ? props.STATE : null;
    if (!name || !fips) continue;
    const usps = fipsToUsps(fips);
    if (!usps) continue;
    const geom = feature.geometry;
    if (!geom) continue;
    const key = `${usps}:${name.toLowerCase()}`;
    if (geom.type === 'MultiPolygon') {
      byKey.set(key, geom);
    } else if (geom.type === 'Polygon') {
      byKey.set(key, { type: 'MultiPolygon', coordinates: [geom.coordinates] });
    }
  }
  return (name, state) => byKey.get(`${state.toUpperCase()}:${name.toLowerCase()}`) ?? null;
}

/**
 * Parse NWS `area_desc` into state-qualified county names for a specific set
 * of states. Multi-state watches (e.g. a TO.A straddling the IL/WI border)
 * list every affected county with its state suffix — we MUST filter to the
 * allowed states or we'll hydrate wrong-state counties that happen to share
 * a name with a covered-state county (e.g. `Winnebago, IL` vs our
 * `Winnebago, WI`).
 *
 * Observed shapes for WI-scope products:
 *   "Dane, WI"
 *   "Dane, WI; Rock, WI; Green, WI"
 *   "Fond du Lac, WI"
 *   "Winnebago, IL; Boone, IL; Winnebago, WI"  (cross-state watch)
 *
 * Segments are split on `;`. For each segment:
 *   - If it ends with `, <ST>` where ST is in `allowedStates`, the suffix is
 *     stripped and `{ name, state: ST }` is returned.
 *   - If it ends with `, <ST>` where ST is NOT allowed, the segment is dropped.
 *   - If it has no state suffix, it's returned with the first allowed state
 *     as a default. Real NWS products always include state codes, but keeping
 *     the fallback means malformed or simplified inputs still surface against
 *     the primary scope.
 *
 * Default `allowedStates` is `['WI']` — SeeStorm's historical product scope.
 */
export function parseCountyNamesFromAreaDesc(
  areaDesc: string,
  options: { allowedStates?: readonly string[] } = {},
): Array<{ name: string; state: string }> {
  if (!areaDesc) return [];
  const allowedList = (options.allowedStates ?? ['WI']).map((s) => s.toUpperCase());
  const allowed = new Set(allowedList);
  const defaultState = allowedList[0] ?? 'WI';
  const results: Array<{ name: string; state: string }> = [];
  for (const raw of areaDesc.split(';')) {
    const segment = raw.trim();
    if (!segment) continue;
    const match = segment.match(/^(.*),\s*([A-Z]{2})$/);
    if (match) {
      const [, name, state] = match;
      if (allowed.has(state)) results.push({ name: name.trim(), state });
      // else: drop segment — out-of-scope state.
      continue;
    }
    results.push({ name: segment, state: defaultState });
  }
  return results;
}

/**
 * Synthesize a MultiPolygon covering every county in `area_desc` that
 * resolves against `lookup`. Returns null when no names match — callers can
 * treat that as "nothing to draw" and leave the alert off the map (it still
 * surfaces in the side panel).
 */
export function synthesizeGeometryFromAreaDesc(
  areaDesc: string,
  lookup: CountyLookup,
  options: { allowedStates?: readonly string[] } = {},
): GeoJSON.MultiPolygon | null {
  const entries = parseCountyNamesFromAreaDesc(areaDesc, options);
  const coordinates: GeoJSON.Position[][][] = [];
  for (const { name, state } of entries) {
    const hit = lookup(name, state);
    if (hit) coordinates.push(...hit.coordinates);
  }
  if (coordinates.length === 0) return null;
  return { type: 'MultiPolygon', coordinates };
}
