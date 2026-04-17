// Basemap contrast boost — makes roads and place labels readable through the
// radar + alert overlays.
//
// The CartoDB Dark Matter style renders its road lines and city labels with
// muted opacity + thin halos by design; stacked underneath radar (60% opacity)
// and warning fills (up to 20%), those underlying features visually disappear.
// This module walks the loaded style once and bumps the paint properties that
// most affect readability — without mutating overlay layer opacity, so alert
// urgency signalling is unchanged.
//
// We match by `source-layer` rather than layer ID because the OpenMapTiles
// vector schema used by CartoDB (and Protomaps, Stadia, etc.) assigns stable
// source-layer names even when style authors rename/rearrange layers. That
// keeps this helper working if we swap basemap providers.

// Vector source-layer names that represent drivable road / rail geometry.
// Lifted from the OpenMapTiles schema; the duplicates cover schema variants
// shipped by different basemap vendors.
const ROAD_SOURCE_LAYERS: ReadonlySet<string> = new Set([
  'transportation',
  'road',
  'roads',
  'bridge',
  'tunnel',
]);

// Vector source-layer names that carry text labels we want to lift through
// the overlays: place names (cities/towns), road shields, water body names.
//
// Deliberately excludes `poi`: the user asked for roads and city names, and
// lifting every restaurant/park/business label through the radar stack would
// add the visual noise we're trying to cut.
const LABEL_SOURCE_LAYERS: ReadonlySet<string> = new Set([
  'place',
  'place_label',
  'transportation_name',
  'road_label',
  'water_name',
]);

// Boost factor applied to existing road `line-width`. 1.4× is visible without
// making roads look cartoonishly thick at high zoom — empirically tuned on the
// CartoDB Dark Matter default style at zoom 7–12 (the SeeStorm viewport range).
const ROAD_WIDTH_BOOST = 1.4;

// Minimal structural subset of the MapLibre Map API we need. Declared locally
// (not imported from maplibre-gl) so the helper can be unit-tested without a
// real map instance — matches the pattern used in `stormMotion.ts`.
export interface ContrastTarget {
  getStyle(): { layers?: ReadonlyArray<StyleLayer> } | undefined;
  getPaintProperty(layerId: string, prop: string): unknown;
  setPaintProperty(layerId: string, prop: string, value: unknown): void;
}

// Narrow, read-only view of a MapLibre `LayerSpecification`. The real type is a
// discriminated union with ~12 variants; we only care about id, type, and the
// vector-tile `source-layer` tag.
export interface StyleLayer {
  id: string;
  type: string;
  'source-layer'?: string;
}

/**
 * Apply basemap contrast tweaks to every matching layer in the current style.
 *
 * - Road lines: opacity → 1, width × {@link ROAD_WIDTH_BOOST}.
 * - Label symbols: full-opacity text with a dark halo so names read cleanly
 *   against both the dark basemap AND the radar/alert overlays above.
 *
 * Safe to call multiple times — re-applying the road width boost is idempotent
 * in practice because we wrap the existing width expression with a multiply;
 * repeated calls would compound, so only call once after `map.on('load')`.
 *
 * Silently skips any layer whose paint surface doesn't match expectations —
 * a single malformed layer must not block map initialization.
 */
export function boostBasemapContrast(map: ContrastTarget): void {
  const style = map.getStyle();
  const layers = style?.layers;
  if (!layers) return;

  for (const layer of layers) {
    const sourceLayer = layer['source-layer'];
    if (!sourceLayer) continue;

    try {
      if (layer.type === 'line' && ROAD_SOURCE_LAYERS.has(sourceLayer)) {
        boostRoadLine(map, layer.id);
      } else if (layer.type === 'symbol' && LABEL_SOURCE_LAYERS.has(sourceLayer)) {
        boostLabelSymbol(map, layer.id);
      }
    } catch {
      // Intentionally swallow: unexpected expression shape on one layer must
      // not stop us boosting the rest of the style.
    }
  }
}

function boostRoadLine(map: ContrastTarget, layerId: string): void {
  map.setPaintProperty(layerId, 'line-opacity', 1);

  // The existing `line-width` is usually a zoom-interpolated expression in
  // CartoDB's style. Wrapping it with `['*', current, BOOST]` works whether
  // the value is a scalar number or a nested MapLibre expression, so we don't
  // have to special-case either.
  const width = map.getPaintProperty(layerId, 'line-width');
  if (width === undefined || width === null) return;
  map.setPaintProperty(layerId, 'line-width', ['*', width, ROAD_WIDTH_BOOST]);
}

function boostLabelSymbol(map: ContrastTarget, layerId: string): void {
  // Deliberately leave `text-opacity` alone — basemap styles commonly fade
  // low-priority labels by zoom with an opacity expression, and hard-setting
  // to 1 would force every matched label to render at every zoom. The halo
  // alone is enough to make names punch through the radar + alert overlays.
  map.setPaintProperty(layerId, 'text-halo-color', '#000000');
  map.setPaintProperty(layerId, 'text-halo-width', 2);
  map.setPaintProperty(layerId, 'text-halo-blur', 0.5);
}
