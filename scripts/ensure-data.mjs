/**
 * ensure-data.mjs — download Census source data and generate the county
 * GeoJSON + ZIP lookup files if they don't already exist.
 *
 * Runs as the npm `prebuild` hook so Cloudflare Workers builds get the
 * generated data files without committing ~27 MB to the repo.
 *
 * Source data (public domain, US Census Bureau):
 *   - TIGER 500k county boundaries shapefile (~12 MB zipped)
 *   - ZCTA 2020 Gazetteer (~3 MB zipped)
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { createWriteStream } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TMP = resolve(ROOT, 'tmp');

const COUNTY_MARKER = resolve(ROOT, 'public/geo/counties/WI.geojson');
const ZIP_MARKER = resolve(ROOT, 'public/data/zip-us.json');

const TIGER_URL = 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip';
const GAZ_URL =
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const stream = createWriteStream(dest);
        res.pipe(stream);
        stream.on('finish', () => {
          stream.close();
          resolve();
        });
        stream.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

const needsCounty = !existsSync(COUNTY_MARKER);
const needsZip = !existsSync(ZIP_MARKER);

if (!needsCounty && !needsZip) {
  console.log('[ensure-data] County + ZIP data already exist, skipping.');
  process.exit(0);
}

console.log('[ensure-data] Downloading Census source data...');
await mkdir(TMP, { recursive: true });

const tigerZip = resolve(TMP, 'cb_2020_us_county_500k.zip');
const gazZip = resolve(TMP, 'gaz.zip');

if (!existsSync(resolve(TMP, 'cb_2020_us_county_500k.shp'))) {
  console.log(`[ensure-data] Downloading TIGER shapefile...`);
  await download(TIGER_URL, tigerZip);
  execSync(`unzip -o "${tigerZip}" -d "${TMP}"`, { stdio: 'inherit' });
}

if (needsZip && !existsSync(resolve(TMP, '2020_Gaz_zcta_national.txt'))) {
  console.log(`[ensure-data] Downloading ZCTA gazetteer...`);
  await download(GAZ_URL, gazZip);
  execSync(`unzip -o "${gazZip}" -d "${TMP}"`, { stdio: 'inherit' });
}

if (needsCounty) {
  console.log('[ensure-data] Generating county GeoJSON...');
  execSync('npm run build:geo', { cwd: ROOT, stdio: 'inherit' });
}

if (needsZip) {
  console.log('[ensure-data] Generating ZIP lookup...');
  execSync('npm run build:zip', { cwd: ROOT, stdio: 'inherit' });
}

console.log('[ensure-data] Done.');
