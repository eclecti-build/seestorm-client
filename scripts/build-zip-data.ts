/**
 * build-zip-data.ts — regenerate `public/data/zip-greatlakes.json`.
 *
 * Pulls the US Census 2020 ZCTA Gazetteer (public domain), filters down to
 * the 9 SeeStorm states (MN, WI, IA, IL, IN, MI, OH, PA, NY — GL 8 + Iowa),
 * and writes the compact `{[zip]: {lat, lon, state, county}}` shape consumed
 * by `src/lib/zipLookup.ts`.
 *
 * Why a script instead of build-time generation:
 *   - The Gazetteer is ~10 MB compressed and we only need ~80 KB of it.
 *     Running this manually keeps `npm install` light and CI fast.
 *   - ZCTAs change once a year at most. There's no reason to rebuild on
 *     every commit.
 *
 * Usage (one-time, when refreshing data):
 *   1. Download the Census ZCTA Gazetteer (~3 MB zipped):
 *        curl -sSL -o tmp/gaz.zip \
 *          https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip
 *        unzip -o tmp/gaz.zip -d tmp/
 *   2. Download the Census county shapefile (only if you want county
 *      names attached — optional, see note below):
 *        https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip
 *   3. Run:
 *        npx tsx scripts/build-zip-data.ts
 *
 * The Gazetteer file is TAB-separated text with a header row. Columns:
 *   GEOID    — 5-digit ZCTA (acts as the ZIP key for this lookup)
 *   ALAND, AWATER, ALAND_SQMI, AWATER_SQMI
 *   INTPTLAT — internal point latitude  (centroid)
 *   INTPTLONG— internal point longitude
 *
 * The national ZCTA file does NOT carry state — ZCTAs cross state lines.
 * To attach a state we cross-reference each ZCTA's INTPT coordinates
 * against the bundled `public/geo/us-states.geojson` (ships in-repo).
 *
 * County attachment is OPTIONAL. The runtime only reads `state` from each
 * record; `county` is a string (may be empty) kept for future display.
 * If the county shapefile is absent, emit `county: ''` — the checked-in
 * `public/data/zip-greatlakes.json` is currently state-only for this
 * reason, and `zipData.test.ts` enforces state coverage in CI.
 *
 * Both source files are public-domain Census products. URLs:
 *   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip
 *   https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip
 *
 * The script intentionally does NOT auto-download (proxies, retry logic,
 * checksumming all add noise) — fetch them once into `tmp/` and re-run.
 */

import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
// turf is already a dependency; we use it for point-in-polygon to assign
// county/state to each ZCTA centroid.
import * as turf from '@turf/turf';

const TARGET_STATES = new Set(['MN', 'WI', 'IA', 'IL', 'IN', 'MI', 'OH', 'PA', 'NY']);

const GAZETTEER_PATH = resolve('tmp/2020_Gaz_zcta_national.txt');
const COUNTIES_GEOJSON_PATH = resolve('tmp/cb_2020_us_county_500k.geojson');
const OUTPUT_PATH = resolve('public/data/zip-greatlakes.json');

interface ZcRow {
  zip: string;
  lat: number;
  lon: number;
}

interface CountyFeatureProps {
  STATEFP: string; // FIPS state code, e.g. "55" for WI
  NAME: string;
  STATE_NAME?: string;
}

// FIPS state code → USPS code, for the 9 target states (GL 8 + Iowa).
const FIPS_TO_USPS: Record<string, string> = {
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

async function readGazetteer(path: string): Promise<ZcRow[]> {
  const rows: ZcRow[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let firstLine = true;
  for await (const line of rl) {
    if (firstLine) {
      firstLine = false;
      continue; // header
    }
    // Tab-separated; columns: GEOID, ALAND, AWATER, ALAND_SQMI, AWATER_SQMI, INTPTLAT, INTPTLONG
    const parts = line.split('\t').map((p) => p.trim());
    if (parts.length < 7) continue;
    const zip = parts[0];
    const lat = Number.parseFloat(parts[5]);
    const lon = Number.parseFloat(parts[6]);
    if (!/^\d{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({ zip, lat, lon });
  }
  return rows;
}

interface CountyHit {
  state: string;
  county: string;
}

function buildCountyResolver(
  fc: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, CountyFeatureProps>,
): (lat: number, lon: number) => CountyHit | null {
  // Filter to target states once so per-point lookup is cheaper.
  const features = fc.features.filter((f) => FIPS_TO_USPS[f.properties.STATEFP]);
  return (lat, lon) => {
    const pt = turf.point([lon, lat]);
    for (const f of features) {
      try {
        if (turf.booleanPointInPolygon(pt, f as GeoJSON.Feature<GeoJSON.Polygon>)) {
          return {
            state: FIPS_TO_USPS[f.properties.STATEFP],
            county: f.properties.NAME,
          };
        }
      } catch {
        // skip malformed polygon
      }
    }
    return null;
  };
}

async function main(): Promise<void> {
  console.log('Reading gazetteer:', GAZETTEER_PATH);
  const zcs = await readGazetteer(GAZETTEER_PATH);
  console.log(`  ${zcs.length} ZCTAs`);

  console.log('Reading counties:', COUNTIES_GEOJSON_PATH);
  // readFile + JSON.parse avoids Windows ESM url-scheme limitation where
  // `import('C:/...')` errors with ERR_UNSUPPORTED_ESM_URL_SCHEME. Same
  // input, same parsed shape — just no dynamic-import round trip.
  const countiesRaw = await readFile(COUNTIES_GEOJSON_PATH, 'utf8');
  const counties = JSON.parse(countiesRaw) as GeoJSON.FeatureCollection<
    GeoJSON.Polygon | GeoJSON.MultiPolygon,
    CountyFeatureProps
  >;
  const resolveCounty = buildCountyResolver(counties);

  const out: Record<string, { lat: number; lon: number; state: string; county: string }> = {};
  for (const { zip, lat, lon } of zcs) {
    const hit = resolveCounty(lat, lon);
    if (!hit) continue;
    if (!TARGET_STATES.has(hit.state)) continue;
    out[zip] = { lat, lon, state: hit.state, county: hit.county };
  }

  console.log(`  ${Object.keys(out).length} ZCTAs in target states`);

  await writeFile(OUTPUT_PATH, JSON.stringify(out));
  console.log('Wrote', OUTPUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
