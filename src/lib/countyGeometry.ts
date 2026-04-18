// Pure helpers for hydrating zone-only alerts (e.g. Tornado Watches) with
// synthesized polygon geometry. NWS issues Watches as county-wide products
// with no polygon — only `area_desc` and sometimes UGC codes. Until the
// ingest contract carries structured UGC, we parse `area_desc` county names
// and union the matching county polygons from the bundled
// `public/geo/greatlakes-counties.geojson` (covers all 8 supported states).
//
// Kept pure (no React, no fetch) so unit tests cover the full path.

export type CountyLookup = (name: string) => GeoJSON.MultiPolygon | null;

/**
 * Build a case-insensitive county-name → MultiPolygon lookup from a bundled
 * counties FeatureCollection. Features with missing NAME or non-polygonal
 * geometry are skipped. Polygon geometries are promoted to single-member
 * MultiPolygons so callers have a uniform shape.
 */
export function buildCountyLookup(fc: GeoJSON.FeatureCollection): CountyLookup {
  const byName = new Map<string, GeoJSON.MultiPolygon>();
  for (const feature of fc.features) {
    const name =
      feature.properties && typeof feature.properties.NAME === 'string'
        ? feature.properties.NAME
        : null;
    if (!name) continue;
    const geom = feature.geometry;
    if (!geom) continue;
    if (geom.type === 'MultiPolygon') {
      byName.set(name.toLowerCase(), geom);
    } else if (geom.type === 'Polygon') {
      byName.set(name.toLowerCase(), { type: 'MultiPolygon', coordinates: [geom.coordinates] });
    }
  }
  return (name) => byName.get(name.toLowerCase()) ?? null;
}

/**
 * Parse NWS `area_desc` into candidate county names for a specific set of
 * states. Multi-state watches (e.g. a TO.A straddling the IL/WI border) list
 * every affected county with its state suffix — we MUST filter to the
 * allowed states or we'll hydrate wrong-state counties that happen to share
 * a name with a Wisconsin county (e.g. "Winnebago, IL" → our WI Winnebago).
 *
 * Observed shapes for WI-scope products:
 *   "Dane, WI"
 *   "Dane, WI; Rock, WI; Green, WI"
 *   "Fond du Lac, WI"
 *   "Winnebago, IL; Boone, IL; Winnebago, WI"  (cross-state watch)
 *
 * Segments are split on `;`. For each segment:
 *   - If it ends with `, <ST>` where ST is in `allowedStates`, the suffix is
 *     stripped and the name is returned.
 *   - If it ends with `, <ST>` where ST is NOT allowed, the segment is dropped.
 *   - If it has no state suffix, it's returned as-is. Real NWS products
 *     always include state codes, but keeping the fallback means malformed
 *     or simplified inputs still surface.
 *
 * Default `allowedStates` is `['WI']` — SeeStorm's product scope.
 */
export function parseCountyNamesFromAreaDesc(
  areaDesc: string,
  options: { allowedStates?: readonly string[] } = {},
): string[] {
  if (!areaDesc) return [];
  const allowed = new Set((options.allowedStates ?? ['WI']).map((s) => s.toUpperCase()));
  const results: string[] = [];
  for (const raw of areaDesc.split(';')) {
    const segment = raw.trim();
    if (!segment) continue;
    const match = segment.match(/^(.*),\s*([A-Z]{2})$/);
    if (match) {
      const [, name, state] = match;
      if (allowed.has(state)) results.push(name.trim());
      // else: drop segment — out-of-scope state.
      continue;
    }
    results.push(segment);
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
  const names = parseCountyNamesFromAreaDesc(areaDesc, options);
  const coordinates: GeoJSON.Position[][][] = [];
  for (const name of names) {
    const hit = lookup(name);
    if (hit) coordinates.push(...hit.coordinates);
  }
  if (coordinates.length === 0) return null;
  return { type: 'MultiPolygon', coordinates };
}
