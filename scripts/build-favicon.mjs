/**
 * build-favicon.mjs — generate favicon.ico + apple-icon.png from icon.svg.
 *
 * One-off asset build. Run when src/app/icon.svg changes:
 *   node scripts/build-favicon.mjs
 *
 * Writes:
 *   src/app/favicon.ico     — multi-size ICO (16/32/48), used by legacy browsers
 *                             and tools that only read .ico.
 *   src/app/apple-icon.png  — 180x180 PNG for iOS home-screen.
 *
 * Modern browsers prefer icon.svg (already present) via Next.js App Router
 * conventions; favicon.ico is the fallback.
 *
 * Why manual ICO packing instead of a dep like png-to-ico:
 *   The ICO container is ~100 lines of well-documented format; adding a
 *   one-off generation dep for a file that changes ~once a year is overkill.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, '..', 'src', 'app');
const svgPath = resolve(appDir, 'icon.svg');
const icoPath = resolve(appDir, 'favicon.ico');
const appleIconPath = resolve(appDir, 'apple-icon.png');

const svg = readFileSync(svgPath);

async function renderPng(size) {
  return sharp(svg).resize(size, size).png().toBuffer();
}

/**
 * Pack PNG buffers into an ICO file.
 * ICO layout: 6-byte header + N * 16-byte directory entries + concatenated PNG data.
 * Each directory entry points at a PNG by offset+size; width/height of 0 means 256.
 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4); // image count

  const dirSize = 16 * images.length;
  let offset = header.length + dirSize;
  const dirEntries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8); // image size
    entry.writeUInt32LE(offset, 12); // offset of PNG data
    dirEntries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...images.map((img) => img.data)]);
}

async function main() {
  const icoSizes = [16, 32, 48];
  const icoImages = await Promise.all(
    icoSizes.map(async (size) => ({ size, data: await renderPng(size) })),
  );
  writeFileSync(icoPath, packIco(icoImages));
  console.log(`wrote ${icoPath} (${icoSizes.join('/')})`);

  const appleIcon = await renderPng(180);
  writeFileSync(appleIconPath, appleIcon);
  console.log(`wrote ${appleIconPath} (180x180)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
