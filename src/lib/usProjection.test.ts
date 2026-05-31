import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { projectContiguous, regionBounds, regionViewBox } from './usProjection';

const geojson = JSON.parse(
  readFileSync(join(process.cwd(), 'public/geo/us-states.geojson'), 'utf8'),
) as FeatureCollection;

const projected = projectContiguous(geojson);
const byCode = new Map(projected.features.map((f) => [f.code, f]));

describe('projectContiguous', () => {
  it('keeps the 49 contiguous jurisdictions and drops AK/HI/PR outliers', () => {
    expect(projected.features.length).toBe(49);
    expect(byCode.has('AK')).toBe(false);
    expect(byCode.has('HI')).toBe(false);
    expect(byCode.has('PR')).toBe(false);
    expect(byCode.has('WI')).toBe(true);
    expect(byCode.has('DC')).toBe(true);
  });

  it('emits a non-empty SVG path for every feature', () => {
    for (const f of projected.features) {
      expect(f.d.startsWith('M')).toBe(true);
      expect(f.d.length).toBeGreaterThan(8);
    }
  });

  it('projects every vertex inside the viewBox', () => {
    for (const f of projected.features) {
      expect(f.bounds.minX).toBeGreaterThanOrEqual(0);
      expect(f.bounds.minY).toBeGreaterThanOrEqual(0);
      expect(f.bounds.maxX).toBeLessThanOrEqual(projected.width + 1e-6);
      expect(f.bounds.maxY).toBeLessThanOrEqual(projected.height + 1e-6);
    }
  });

  it('preserves east–west orientation (California sits left of New York)', () => {
    const ca = byCode.get('CA')!;
    const ny = byCode.get('NY')!;
    expect(ca.centroid.x).toBeLessThan(ny.centroid.x);
  });

  it('preserves north–south orientation, north up (Minnesota above Florida)', () => {
    const mn = byCode.get('MN')!;
    const fl = byCode.get('FL')!;
    expect(mn.centroid.y).toBeLessThan(fl.centroid.y);
  });

  it('produces a US-shaped aspect ratio (~1.9:1)', () => {
    const aspect = projected.width / projected.height;
    expect(aspect).toBeGreaterThan(1.75);
    expect(aspect).toBeLessThan(2.05);
  });

  it('tags each feature with its region id for colouring', () => {
    expect(byCode.get('WI')!.region).toBe('midwest');
    expect(byCode.get('CA')!.region).toBe('west');
    expect(byCode.get('FL')!.region).toBe('south');
  });
});

describe('regionBounds / regionViewBox', () => {
  it('unions a region into a sub-box that sits inside the full map', () => {
    const b = regionBounds(projected.features, 'midwest');
    expect(b).not.toBeNull();
    expect(b!.minX).toBeGreaterThanOrEqual(0);
    expect(b!.minY).toBeGreaterThanOrEqual(0);
    expect(b!.maxX).toBeLessThanOrEqual(projected.width + 1e-6);
    expect(b!.maxY).toBeLessThanOrEqual(projected.height + 1e-6);
    // One region is narrower than the whole contiguous map.
    expect(b!.maxX - b!.minX).toBeLessThan(projected.width);
  });

  it('encloses every member state of the region', () => {
    const b = regionBounds(projected.features, 'plains')!;
    for (const f of projected.features.filter((x) => x.region === 'plains')) {
      expect(f.bounds.minX).toBeGreaterThanOrEqual(b.minX - 1e-6);
      expect(f.bounds.maxX).toBeLessThanOrEqual(b.maxX + 1e-6);
      expect(f.bounds.minY).toBeGreaterThanOrEqual(b.minY - 1e-6);
      expect(f.bounds.maxY).toBeLessThanOrEqual(b.maxY + 1e-6);
    }
  });

  it('regionViewBox frames the region with padding (4 finite numbers)', () => {
    const vb = regionViewBox(projected.features, 'newengland');
    expect(vb).not.toBeNull();
    const [x, y, w, h] = vb!.split(' ').map(Number);
    expect([x, y, w, h].every((n) => Number.isFinite(n))).toBe(true);
    const b = regionBounds(projected.features, 'newengland')!;
    expect(x).toBeLessThan(b.minX); // padded out on the left/top
    expect(y).toBeLessThan(b.minY);
    expect(w).toBeGreaterThan(b.maxX - b.minX); // larger than the bare region
    expect(h).toBeGreaterThan(b.maxY - b.minY);
  });

  it('returns null for a region with no projected features', () => {
    expect(regionBounds([], 'west')).toBeNull();
    expect(regionViewBox([], 'west')).toBeNull();
  });
});
