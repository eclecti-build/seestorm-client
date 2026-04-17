// Storm motion vector features for MapLibre rendering.
//
// The ingest pipeline parses NWS `TIME...MOT...LOC` blocks into a StormMotion
// struct and attaches it to alerts. This module turns that data into a
// MapLibre-ready FeatureCollection: one origin dot, one dashed forward-projected
// line out to the 45-minute mark, and tick features at 15 / 30 / 45 minutes so
// the map can paint an arrowhead at the terminus.
//
// CRITICAL: NWS encodes `direction_deg` as the bearing the storm comes FROM.
// Rendering needs the bearing the storm is moving TOWARD. We invert once here
// (forwardBearing = (direction_deg + 180) % 360) and store the forward bearing
// on every feature so map layers can just read it off properties.

import * as turf from '@turf/turf';

export interface StormMotion {
  origin_lat: number;
  origin_lon: number;
  direction_deg: number; // FROM which storm comes
  speed_kt: number;
  valid_at: string; // ISO-8601
  // Optional list of lat,lon pairs when the warning covers a multi-cell storm
  // line. `[0]` equals `[origin_lat, origin_lon]`. Absent (undefined) for
  // single-point motion, which is the common case. Carried for type-safety
  // against the ingest payload; the renderer ignores it for now and still
  // projects forward from the single origin + bearing.
  points?: [number, number][];
}

export interface MotionSourceAlert {
  nws_id: string;
  event_type: string;
  storm_motion?: StormMotion | null;
  // Optional polygon/geometry from the alert. `buildMotionFeatures` uses this
  // only to decide whether the parent alert would render on the main alerts
  // source — alerts with `geometry == null` are dropped by `snapshotToFeatures`,
  // so we skip them here too and avoid emitting orphan motion vectors that
  // would float with no accompanying polygon.
  geometry?: GeoJSON.Geometry | null;
}

// MapLibre layer IDs that carry storm-motion features. Exported so the map
// component can iterate them (e.g. to toggle visibility in forecast mode)
// without duplicating the list. Order is deterministic for tests.
export const MOTION_LAYER_IDS = [
  'motion-line',
  'motion-origin',
  'motion-head',
  'motion-ticks',
  'motion-label',
] as const;

// Knots → mph conversion (1 kt = 1.15077945 mph). Exported for tests + UI.
export const MPH_PER_KT = 1.15077945;

export function ktToMph(kt: number): number {
  return Math.round(kt * MPH_PER_KT);
}

// Minimal structural subset of the MapLibre Map API that `setMotionVisibility`
// depends on — lets the helper stay unit-testable without pulling in maplibre-gl.
export interface LayerVisibilityMap {
  setLayoutProperty(layerId: string, prop: 'visibility', value: 'visible' | 'none'): void;
  getLayer(layerId: string): unknown;
}

/**
 * Toggle visibility of every storm-motion layer registered in
 * `MOTION_LAYER_IDS`. No-op for any layer that isn't currently on the map,
 * so the helper is safe to call before layer registration completes or after
 * a partial teardown.
 */
export function setMotionVisibility(map: LayerVisibilityMap, visible: boolean): void {
  const value = visible ? 'visible' : 'none';
  for (const id of MOTION_LAYER_IDS) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', value);
  }
}

// Nautical miles per kilometer conversion.
const KM_PER_NM = 1.852;

// Tick intervals in minutes — fixed by product spec, not configurable.
const TICK_MINUTES: readonly [15, 30, 45] = [15, 30, 45];

interface MotionFeatureProperties {
  kind: 'origin' | 'line' | 'tick' | 'label';
  event: string;
  valid_at: string;
  nws_id: string;
  tick?: 15 | 30 | 45;
  bearing?: number;
  speed_kt?: number;
  speed_mph?: number;
  label?: string;
}

/**
 * Build MapLibre-ready motion features from an alert list.
 *
 * For each alert carrying a non-null `storm_motion`, emits (in this order):
 *   1. Origin Point at `[origin_lon, origin_lat]`.
 *   2. Projected LineString from origin to the 45-minute forward terminus.
 *   3. Three tick Points at 15 / 30 / 45 minutes along the forward bearing.
 *
 * Alerts without storm_motion are skipped entirely. Alerts whose `geometry`
 * is null/undefined are also skipped — they are filtered out of the main
 * alerts source by `snapshotToFeatures`, so emitting motion features for
 * them would produce orphan vectors with no accompanying polygon.
 */
export function buildMotionFeatures(
  alerts: readonly MotionSourceAlert[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const alert of alerts) {
    const motion = alert.storm_motion;
    if (!motion) continue;
    if (alert.geometry == null) continue;

    const { origin_lat, origin_lon, direction_deg, speed_kt, valid_at } = motion;
    const forwardBearing = (direction_deg + 180) % 360;
    const originCoord: [number, number] = [origin_lon, origin_lat];

    // Origin point — always at the reported origin, never projected.
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: originCoord },
      properties: {
        kind: 'origin',
        event: alert.event_type,
        valid_at,
        nws_id: alert.nws_id,
      } satisfies MotionFeatureProperties,
    });

    // 45-minute terminus. For stationary storms (speed_kt === 0) this collapses
    // to the origin, which is fine — turf.destination handles distance=0 by
    // returning the input point.
    const distance45Km = speed_kt * 0.75 * KM_PER_NM;
    const terminus45 = turf.destination(turf.point(originCoord), distance45Km, forwardBearing, {
      units: 'kilometers',
    });
    const terminus45Coords = terminus45.geometry.coordinates as [number, number];

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [originCoord, terminus45Coords],
      },
      properties: {
        kind: 'line',
        event: alert.event_type,
        valid_at,
        nws_id: alert.nws_id,
      } satisfies MotionFeatureProperties,
    });

    // Tick marks at 15 / 30 / 45. Each gets the forward bearing so the map
    // layer can rotate the arrowhead icon on the 45-min feature via
    // `icon-rotate: ['get', 'bearing']`.
    for (const tick of TICK_MINUTES) {
      const tickDistanceKm = speed_kt * (tick / 60) * KM_PER_NM;
      const tickPoint = turf.destination(turf.point(originCoord), tickDistanceKm, forwardBearing, {
        units: 'kilometers',
      });
      features.push({
        type: 'Feature',
        geometry: tickPoint.geometry,
        properties: {
          kind: 'tick',
          tick,
          bearing: forwardBearing,
          event: alert.event_type,
          valid_at,
          nws_id: alert.nws_id,
        } satisfies MotionFeatureProperties,
      });
    }

    // Speed label — single Point co-located with the 45-minute terminus. The
    // map renders it as a text symbol with a dark halo so it reads against
    // radar and basemap alike. mph is the unit the public understands;
    // speed_kt is kept on the feature in case the UI surfaces it elsewhere.
    const speed_mph = ktToMph(speed_kt);
    features.push({
      type: 'Feature',
      geometry: terminus45.geometry,
      properties: {
        kind: 'label',
        bearing: forwardBearing,
        speed_kt,
        speed_mph,
        label: `${speed_mph} mph`,
        event: alert.event_type,
        valid_at,
        nws_id: alert.nws_id,
      } satisfies MotionFeatureProperties,
    });
  }

  return { type: 'FeatureCollection', features };
}
