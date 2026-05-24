/**
 * build-county-data.ts — regenerate per-state county GeoJSON files in
 * `public/geo/counties/{STATE}.geojson`.
 *
 * Reads the US Census 2020 cartographic boundary counties file (500k
 * resolution, public domain), splits by state, normalizes property names
 * to match the legacy county GeoJSON shape, and writes one file per
 * state/territory.
 *
 * Per-state splitting keeps individual files small (~100-300 KB each)
 * so the client can lazy-load only the selected state's counties.
 *
 * Usage (one-time, when refreshing data):
 *   1. Download and unzip the TIGER 500k counties shapefile (~12 MB):
 *        mkdir -p tmp
 *        curl -sSL -o tmp/cb_2020_us_county_500k.zip \
 *          https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip
 *        unzip -o tmp/cb_2020_us_county_500k.zip -d tmp/
 *   2. Run:
 *        npx tsx scripts/build-county-data.ts
 *
 * Output property mapping (TIGER → legacy shape):
 *   STATEFP        → STATE      (FIPS state code, e.g. "55")
 *   COUNTYFP       → COUNTY     (FIPS county code, e.g. "025")
 *   NAME           → NAME       (display name, e.g. "Dane")
 *   LSAD code      → LSAD       (decoded to text — "County", "Parish", etc.)
 *   GEOID          → GEO_ID     (with "0500000US" prefix)
 *   ALAND / 2.59e6 → CENSUSAREA (sq mi, derived from sq m)
 *
 * Coordinates are rounded to 6 decimal places (~11 cm at the equator).
 *
 * Source: https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip
 *   Public domain; no attribution required for redistribution.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as shapefile from 'shapefile';

// All FIPS state codes → USPS. Process every state/territory in TIGER.
const FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL',
  '02': 'AK',
  '04': 'AZ',
  '05': 'AR',
  '06': 'CA',
  '08': 'CO',
  '09': 'CT',
  '10': 'DE',
  '11': 'DC',
  '12': 'FL',
  '13': 'GA',
  '15': 'HI',
  '16': 'ID',
  '17': 'IL',
  '18': 'IN',
  '19': 'IA',
  '20': 'KS',
  '21': 'KY',
  '22': 'LA',
  '23': 'ME',
  '24': 'MD',
  '25': 'MA',
  '26': 'MI',
  '27': 'MN',
  '28': 'MS',
  '29': 'MO',
  '30': 'MT',
  '31': 'NE',
  '32': 'NV',
  '33': 'NH',
  '34': 'NJ',
  '35': 'NM',
  '36': 'NY',
  '37': 'NC',
  '38': 'ND',
  '39': 'OH',
  '40': 'OK',
  '41': 'OR',
  '42': 'PA',
  '44': 'RI',
  '45': 'SC',
  '46': 'SD',
  '47': 'TN',
  '48': 'TX',
  '49': 'UT',
  '50': 'VT',
  '51': 'VA',
  '53': 'WA',
  '54': 'WV',
  '55': 'WI',
  '56': 'WY',
  '60': 'AS',
  '66': 'GU',
  '69': 'MP',
  '72': 'PR',
  '78': 'VI',
};

const SHP_PATH = resolve('tmp/cb_2020_us_county_500k.shp');
const DBF_PATH = resolve('tmp/cb_2020_us_county_500k.dbf');
const OUTPUT_DIR = resolve('public/geo/counties');

interface TigerCountyProps {
  STATEFP: string;
  COUNTYFP: string;
  GEOID: string;
  NAME: string;
  LSAD: string;
  ALAND: number;
  AWATER: number;
  [key: string]: unknown;
}

interface OutputCountyProps {
  GEO_ID: string;
  STATE: string;
  COUNTY: string;
  NAME: string;
  LSAD: string;
  CENSUSAREA: number;
}

function isTigerCountyProps(value: unknown): value is TigerCountyProps {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.STATEFP === 'string' &&
    typeof v.COUNTYFP === 'string' &&
    typeof v.GEOID === 'string' &&
    typeof v.NAME === 'string' &&
    typeof v.LSAD === 'string' &&
    typeof v.ALAND === 'number'
  );
}

const SQM_TO_SQMI = 1 / 2_589_988.110336;

const LSAD_DECODE: Record<string, string> = {
  '03': 'City and Borough',
  '04': 'Borough',
  '05': 'Census Area',
  '06': 'County',
  '07': 'District',
  '10': 'Island',
  '12': 'Municipality',
  '13': 'Municipio',
  '15': 'Parish',
  '25': 'City',
};

function roundCoord(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  return ring.map((p) => [roundCoord(p[0]), roundCoord(p[1])] as GeoJSON.Position);
}

function roundPolygon(coords: GeoJSON.Position[][]): GeoJSON.Position[][] {
  return coords.map(roundRing);
}

function roundGeometry(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  if (geom.type === 'Polygon') {
    return { type: 'Polygon', coordinates: roundPolygon(geom.coordinates) };
  }
  return {
    type: 'MultiPolygon',
    coordinates: geom.coordinates.map(roundPolygon),
  };
}

async function main(): Promise<void> {
  console.log('Reading shapefile:', SHP_PATH);
  const source = await shapefile.open(SHP_PATH, DBF_PATH);

  // Group features by state FIPS code
  const byState: Record<
    string,
    GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, OutputCountyProps>[]
  > = {};

  let total = 0;
  while (true) {
    const result = await source.read();
    if (result.done) break;
    total += 1;
    const feat = result.value as GeoJSON.Feature;
    if (!isTigerCountyProps(feat.properties)) continue;
    const fips = feat.properties.STATEFP;
    const usps = FIPS_TO_USPS[fips];
    if (!usps) continue;

    const geom = feat.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;

    const props: OutputCountyProps = {
      GEO_ID: `0500000US${feat.properties.GEOID}`,
      STATE: feat.properties.STATEFP,
      COUNTY: feat.properties.COUNTYFP,
      NAME: feat.properties.NAME,
      LSAD: LSAD_DECODE[feat.properties.LSAD] ?? feat.properties.LSAD,
      CENSUSAREA: Number((feat.properties.ALAND * SQM_TO_SQMI).toFixed(3)),
    };

    if (!byState[usps]) byState[usps] = [];
    byState[usps].push({
      type: 'Feature',
      properties: props,
      geometry: roundGeometry(geom),
    });
  }

  console.log(`  scanned ${total} counties total`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const states = Object.keys(byState).sort();
  for (const usps of states) {
    const features = byState[usps];
    const fc: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, OutputCountyProps> =
      {
        type: 'FeatureCollection',
        features,
      };
    const outPath = resolve(OUTPUT_DIR, `${usps}.geojson`);
    await writeFile(outPath, JSON.stringify(fc));
    console.log(`  ${usps}: ${features.length} counties → ${outPath}`);
  }

  console.log(`Wrote ${states.length} state files to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
