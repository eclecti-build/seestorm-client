/**
 * build-county-data.ts — regenerate `public/geo/greatlakes-counties.geojson`.
 *
 * Reads the US Census 2020 cartographic boundary counties file (500k
 * resolution, public domain), filters to the 9 SeeStorm states
 * (MN, WI, IA, IL, IN, MI, OH, PA, NY — Great Lakes 8 + Iowa), normalizes
 * the property names to match the legacy `wi-counties.geojson` shape, and
 * writes the combined GeoJSON artifact consumed by `WeatherMap` and
 * `buildCountyLookup`.
 *
 * Why a script instead of build-time generation:
 *   - The TIGER source is ~12 MB zipped / ~18 MB raw shapefile, but the
 *     filtered GeoJSON is ~700 KB. Doing this at build time would bloat
 *     `npm install` and CI for data that changes once a decade.
 *   - County boundaries are stable. Re-running this is a once-a-decade chore.
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
 * The script intentionally does NOT auto-download — same convention as
 * build-zip-data.ts; fetch the zip into `tmp/` once and re-run as needed.
 *
 * Output property mapping (TIGER → legacy wi-counties.geojson shape):
 *   STATEFP        → STATE      (FIPS state code, e.g. "55")
 *   COUNTYFP       → COUNTY     (FIPS county code, e.g. "025")
 *   NAME           → NAME       (display name, e.g. "Dane")
 *   LSAD code      → LSAD       (decoded to text — "County", "Parish", etc.
 *                                so the file matches the legacy WI shape)
 *   GEOID          → GEO_ID     (with "0500000US" prefix to match legacy)
 *   ALAND / 2.59e6 → CENSUSAREA (sq mi, derived from sq m to mirror legacy)
 *
 * Coordinates are rounded to 6 decimal places (~11 cm at the equator) to
 * keep the bundled file small. The legacy WI file used the same precision.
 *
 * Source: https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip
 *   Public domain; no attribution required for redistribution.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as shapefile from 'shapefile';

// Target FIPS codes for the 9 SeeStorm states (GL 8 + Iowa). Numeric strings
// as TIGER stores them; values are USPS codes for log readability.
const TARGET_FIPS: Record<string, string> = {
  '17': 'IL',
  '18': 'IN',
  '19': 'IA',
  '26': 'MI',
  '27': 'MN',
  '36': 'NY',
  '39': 'OH',
  '42': 'PA',
  '55': 'WI',
};

const SHP_PATH = resolve('tmp/cb_2020_us_county_500k.shp');
const DBF_PATH = resolve('tmp/cb_2020_us_county_500k.dbf');
const OUTPUT_PATH = resolve('public/geo/greatlakes-counties.geojson');

// TIGER DBF properties we care about (others are dropped to keep the file
// small).
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

// Output property shape — preserved identically to the legacy
// `wi-counties.geojson` file so `buildCountyLookup` and any downstream code
// reading these properties keeps working unchanged.
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

// Square meters → square miles. TIGER ALAND is in m^2; legacy CENSUSAREA is
// in mi^2 (rounded to 3 decimals). 1 sq mi = 2,589,988.110336 m^2.
const SQM_TO_SQMI = 1 / 2_589_988.110336;

// LSAD numeric code → display text. The legacy `wi-counties.geojson` stored
// LSAD as plain text ("County"), not the FIPS numeric code. Decoding here
// preserves the legacy contract. Codes per Census MAF/TIGER appendix:
//   https://www.census.gov/library/reference/code-lists/legal-status-codes.html
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

// Round coordinates to 6 decimal places to keep the bundled file small.
// 6 decimals is ~11 cm precision — far finer than county-line rendering needs
// at any zoom we ship, and matches the legacy WI file.
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

  const features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, OutputCountyProps>[] = [];

  // Per-state counter for the summary log — quick sanity check that we got
  // every state and roughly the expected county counts.
  const perStateCount: Record<string, number> = {};

  let total = 0;
  while (true) {
    const result = await source.read();
    if (result.done) break;
    total += 1;
    const feat = result.value as GeoJSON.Feature;
    if (!isTigerCountyProps(feat.properties)) continue;
    const fips = feat.properties.STATEFP;
    if (!TARGET_FIPS[fips]) continue;

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

    features.push({
      type: 'Feature',
      properties: props,
      geometry: roundGeometry(geom),
    });

    perStateCount[fips] = (perStateCount[fips] ?? 0) + 1;
  }

  console.log(`  scanned ${total} counties; kept ${features.length} in target states`);
  for (const fips of Object.keys(TARGET_FIPS).sort()) {
    console.log(`    ${TARGET_FIPS[fips]} (${fips}): ${perStateCount[fips] ?? 0}`);
  }

  const fc: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, OutputCountyProps> = {
    type: 'FeatureCollection',
    features,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(fc));
  console.log('Wrote', OUTPUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
