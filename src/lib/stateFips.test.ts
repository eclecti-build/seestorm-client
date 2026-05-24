import { describe, it, expect } from 'vitest';
import { USPS_TO_FIPS, FIPS_TO_USPS, uspsToFips, fipsToUsps } from './stateFips';

describe('USPS_TO_FIPS table', () => {
  it('covers all 50 states + DC + 5 territories (56 entries)', () => {
    expect(Object.keys(USPS_TO_FIPS)).toHaveLength(56);
    expect(USPS_TO_FIPS['WI']).toBe('55');
    expect(USPS_TO_FIPS['CA']).toBe('06');
    expect(USPS_TO_FIPS['TX']).toBe('48');
    expect(USPS_TO_FIPS['DC']).toBe('11');
    expect(USPS_TO_FIPS['PR']).toBe('72');
    expect(USPS_TO_FIPS['VI']).toBe('78');
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
    expect(uspsToFips('CA')).toBe('06');
  });

  it('is case-insensitive', () => {
    expect(uspsToFips('wi')).toBe('55');
    expect(uspsToFips('Wi')).toBe('55');
  });

  it('returns null for unknown codes', () => {
    expect(uspsToFips('XX')).toBeNull();
    expect(uspsToFips('ZZ')).toBeNull();
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
    expect(fipsToUsps('06')).toBe('CA');
  });

  it('returns null for unknown FIPS codes', () => {
    expect(fipsToUsps('99')).toBeNull();
    expect(fipsToUsps('03')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(fipsToUsps(null)).toBeNull();
    expect(fipsToUsps(undefined)).toBeNull();
    expect(fipsToUsps('')).toBeNull();
  });
});
