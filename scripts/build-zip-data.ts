/**
 * build-zip-data.ts — regenerate `public/data/zip-us.json`.
 *
 * Pulls the US Census 2020 ZCTA Gazetteer (public domain), resolves each
 * ZCTA to a state via point-in-polygon against the county shapefile, and
 * writes the compact `{[zip]: {lat, lon, state, county}}` shape consumed
 * by `src/lib/zipLookup.ts`.
 *
 * Covers all 50 US states + DC + territories that have ZCTA entries.
 *
 * Usage (one-time, when refreshing data):
 *   1. Download the Census ZCTA Gazetteer (~3 MB zipped):
 *        curl -sSL -o tmp/gaz.zip \
 *          https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip
 *        unzip -o tmp/gaz.zip -d tmp/
 *   2. Download the Census county shapefile (for state+county assignment):
 *        curl -sSL -o tmp/cb_2020_us_county_500k.zip \
 *          https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip
 *        unzip -o tmp/cb_2020_us_county_500k.zip -d tmp/
 *   3. Run:
 *        npx tsx scripts/build-zip-data.ts
 *
 * Both source files are public-domain Census products.
 */

import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import * as shapefile from 'shapefile';

// All FIPS state codes → USPS.
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

const GAZETTEER_PATH = resolve('tmp/2020_Gaz_zcta_national.txt');
const SHP_PATH = resolve('tmp/cb_2020_us_county_500k.shp');
const DBF_PATH = resolve('tmp/cb_2020_us_county_500k.dbf');
const OUTPUT_PATH = resolve('public/data/zip-us.json');

interface ZcRow {
  zip: string;
  lat: number;
  lon: number;
}

interface CountyFeatureProps {
  STATEFP: string;
  NAME: string;
  STATE_NAME?: string;
}

async function readGazetteer(path: string): Promise<ZcRow[]> {
  const rows: ZcRow[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let firstLine = true;
  for await (const line of rl) {
    if (firstLine) {
      firstLine = false;
      continue;
    }
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
  features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, CountyFeatureProps>[],
): (lat: number, lon: number) => CountyHit | null {
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

async function readCountyShapefile(): Promise<
  GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, CountyFeatureProps>[]
> {
  const source = await shapefile.open(SHP_PATH, DBF_PATH);
  const features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, CountyFeatureProps>[] =
    [];
  while (true) {
    const result = await source.read();
    if (result.done) break;
    const feat = result.value as GeoJSON.Feature;
    const props = feat.properties as Record<string, unknown> | null;
    if (!props || typeof props.STATEFP !== 'string' || typeof props.NAME !== 'string') continue;
    if (!FIPS_TO_USPS[props.STATEFP as string]) continue;
    const geom = feat.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
    features.push(
      feat as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, CountyFeatureProps>,
    );
  }
  return features;
}

async function main(): Promise<void> {
  console.log('Reading gazetteer:', GAZETTEER_PATH);
  const zcs = await readGazetteer(GAZETTEER_PATH);
  console.log(`  ${zcs.length} ZCTAs`);

  console.log('Reading county shapefile:', SHP_PATH);
  const countyFeatures = await readCountyShapefile();
  console.log(`  ${countyFeatures.length} county features`);
  const resolveCounty = buildCountyResolver(countyFeatures);

  const out: Record<string, { lat: number; lon: number; state: string; county: string }> = {};
  for (const { zip, lat, lon } of zcs) {
    const hit = resolveCounty(lat, lon);
    if (!hit) continue;
    out[zip] = { lat, lon, state: hit.state, county: hit.county };
  }

  console.log(`  ${Object.keys(out).length} ZCTAs resolved`);

  await writeFile(OUTPUT_PATH, JSON.stringify(out));
  console.log('Wrote', OUTPUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
