import { describe, it, expect } from 'vitest';
import { USPS_TO_FIPS, FIPS_TO_USPS, uspsToFips, fipsToUsps } from './stateFips';

describe('USPS_TO_FIPS table', () => {
  it('covers exactly the 8 Great Lakes states', () => {
    expect(Object.keys(USPS_TO_FIPS).sort()).toEqual([
      'IL',
      'IN',
      'MI',
      'MN',
      'NY',
      'OH',
      'PA',
      'WI',
    ]);
  });

  it('uses the canonical Census FIPS codes', () => {
    // These values are stable Census state FIPS codes — if any of these ever
    // diverge from the bundled greatlakes-counties.geojson the county-line
    // filter silently breaks for that state. The matching test for the
    // GeoJSON shape lives in `countyGeometry.test.ts`.
    expect(USPS_TO_FIPS).toEqual({
      IL: '17',
      IN: '18',
      MI: '26',
      MN: '27',
      NY: '36',
      OH: '39',
      PA: '42',
      WI: '55',
    });
  });

  it('is round-trippable through FIPS_TO_USPS', () => {
    for (const [usps, fips] of Object.entries(USPS_TO_FIPS)) {
      expect(FIPS_TO_USPS[fips]).toBe(usps);
    }
  });

  it('is frozen so callers cannot mutate the shared table', () => {
    expect(Object.isFrozen(USPS_TO_FIPS)).toBe(true);
    expect(Object.isFrozen(FIPS_TO_USPS)).toBe(true);
  });
});

describe('uspsToFips', () => {
  it('returns the FIPS code for a known USPS code', () => {
    expect(uspsToFips('WI')).toBe('55');
    expect(uspsToFips('IL')).toBe('17');
  });

  it('is case-insensitive', () => {
    expect(uspsToFips('wi')).toBe('55');
    expect(uspsToFips('Wi')).toBe('55');
  });

  it('returns null for unsupported / unknown codes', () => {
    expect(uspsToFips('CA')).toBeNull(); // out of SeeStorm scope
    expect(uspsToFips('XX')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(uspsToFips(null)).toBeNull();
    expect(uspsToFips(undefined)).toBeNull();
    expect(uspsToFips('')).toBeNull();
  });
});

describe('fipsToUsps', () => {
  it('returns the USPS code for a known FIPS code', () => {
    expect(fipsToUsps('55')).toBe('WI');
    expect(fipsToUsps('36')).toBe('NY');
  });

  it('returns null for unknown FIPS codes', () => {
    expect(fipsToUsps('06')).toBeNull(); // California — out of scope
    expect(fipsToUsps('99')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(fipsToUsps(null)).toBeNull();
    expect(fipsToUsps(undefined)).toBeNull();
    expect(fipsToUsps('')).toBeNull();
  });
});
