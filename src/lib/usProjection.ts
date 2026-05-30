// Lightweight, dependency-free projection of the lower-48 GeoJSON into SVG
// space for the region picker's mini-map.
//
// We deliberately avoid d3-geo: the picker only needs a recognizable
// silhouette, not a survey-grade projection. A latitude-corrected
// equirectangular fit (scale longitude by cos(meanLat)) lands the contiguous
// US at a ~1.9:1 aspect — visually indistinguishable from a proper conic at
// this size — in a few lines of math. Alaska, Hawaii and territories have
// outlier coordinates (AK crosses the antimeridian) and are excluded here;
// the chip surfaces them as separate buttons.

import type { FeatureCollection, Geometry, Position } from 'geojson';
import { NAME_TO_CODE, STATE_TO_REGION, type RegionId } from './regions';

/** Names whose geometry would distort an equirectangular fit of the lower 48. */
const OFFSHORE_NAMES = new Set(['Alaska', 'Hawaii', 'Puerto Rico']);

/** Target width of the projected viewBox in SVG user units. */
const VIEW_WIDTH = 1000;

export interface ProjectedFeature {
  readonly code: string;
  readonly name: string;
  readonly region: RegionId | null;
  /** SVG path data in viewBox space. */
  readonly d: string;
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Bounding-box center — a cheap label/anchor point. */
  readonly centroid: { x: number; y: number };
}

export interface ProjectedMap {
  readonly width: number;
  readonly height: number;
  readonly features: ReadonlyArray<ProjectedFeature>;
}

/** Iterate the polygon rings of a Polygon or MultiPolygon geometry. */
function* rings(geometry: Geometry): Generator<Position[]> {
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) yield ring;
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) yield ring;
    }
  }
}

/**
 * Project the contiguous US (48 states + DC) from a name/density GeoJSON into
 * fitted SVG path data. Features whose name isn't a known state, or that fall
 * in OFFSHORE_NAMES, are skipped. Pure and deterministic.
 */
export function projectContiguous(geojson: FeatureCollection): ProjectedMap {
  const included = geojson.features.filter((f) => {
    const name = typeof f.properties?.name === 'string' ? f.properties.name : null;
    return name !== null && !OFFSHORE_NAMES.has(name) && name in NAME_TO_CODE;
  });

  // First pass: lon/lat bounding box over included geometry.
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const feature of included) {
    for (const ring of rings(feature.geometry)) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }

  const meanLat = (minLat + maxLat) / 2;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const rawWidth = (maxLon - minLon) * k;
  const rawHeight = maxLat - minLat;
  const scale = VIEW_WIDTH / rawWidth;
  const height = rawHeight * scale;

  // North-up: larger latitude → smaller y. West-left: smaller lon → smaller x.
  const projectPoint = (lon: number, lat: number): [number, number] => [
    (lon - minLon) * k * scale,
    (maxLat - lat) * scale,
  ];

  const features: ProjectedFeature[] = [];
  for (const feature of included) {
    const name = feature.properties!.name as string;
    const code = NAME_TO_CODE[name];

    let d = '';
    let fMinX = Infinity;
    let fMinY = Infinity;
    let fMaxX = -Infinity;
    let fMaxY = -Infinity;

    for (const ring of rings(feature.geometry)) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = projectPoint(lon, lat);
        if (x < fMinX) fMinX = x;
        if (x > fMaxX) fMaxX = x;
        if (y < fMinY) fMinY = y;
        if (y > fMaxY) fMaxY = y;
        d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      });
      d += 'Z';
    }

    features.push({
      code,
      name,
      region: STATE_TO_REGION[code] ?? null,
      d,
      bounds: { minX: fMinX, minY: fMinY, maxX: fMaxX, maxY: fMaxY },
      centroid: { x: (fMinX + fMaxX) / 2, y: (fMinY + fMaxY) / 2 },
    });
  }

  return { width: VIEW_WIDTH, height, features };
}
