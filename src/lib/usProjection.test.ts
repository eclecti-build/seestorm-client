import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { projectContiguous } from './usProjection';

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
