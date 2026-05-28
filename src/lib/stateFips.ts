// USPS ↔ FIPS state-code mapping for all US states, DC, and territories.
//
// The runtime carries USPS codes everywhere ('WI', 'IL', etc. — see
// `userLocation.ts`, `LocationChip.tsx`, `alerts.ts`). The bundled county
// GeoJSON (from TIGER) carries FIPS numeric strings ('55', '17', etc.) on
// each feature's `STATE` property. The MapLibre county-line layer needs the
// FIPS code to filter by selected state, so this is the bridge.
//
// Kept tiny and dependency-free so it can be imported by both the runtime
// and the build script without pulling React or MapLibre into either.

/**
 * USPS → FIPS for all 50 states + DC + 5 territories.
 */
export const USPS_TO_FIPS: Readonly<Record<string, string>> = Object.freeze({
  AL: '01',
  AK: '02',
  AZ: '04',
  AR: '05',
  CA: '06',
  CO: '08',
  CT: '09',
  DC: '11',
  DE: '10',
  FL: '12',
  GA: '13',
  HI: '15',
  ID: '16',
  IL: '17',
  IN: '18',
  IA: '19',
  KS: '20',
  KY: '21',
  LA: '22',
  ME: '23',
  MD: '24',
  MA: '25',
  MI: '26',
  MN: '27',
  MS: '28',
  MO: '29',
  MT: '30',
  NE: '31',
  NV: '32',
  NH: '33',
  NJ: '34',
  NM: '35',
  NY: '36',
  NC: '37',
  ND: '38',
  OH: '39',
  OK: '40',
  OR: '41',
  PA: '42',
  RI: '44',
  SC: '45',
  SD: '46',
  TN: '47',
  TX: '48',
  UT: '49',
  VT: '50',
  VA: '51',
  WA: '53',
  WV: '54',
  WI: '55',
  WY: '56',
  // Territories
  AS: '60',
  GU: '66',
  MP: '69',
  PR: '72',
  VI: '78',
});

/**
 * FIPS → USPS for all supported areas. Useful when reading `STATE` off a
 * county feature for logging or debug surfaces.
 */
export const FIPS_TO_USPS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(USPS_TO_FIPS).map(([usps, fips]) => [fips, usps])),
);

/**
 * Convert a USPS code to FIPS. Returns null for unknown codes so callers
 * can decide to skip a filter rather than crash.
 */
export function uspsToFips(usps: string | null | undefined): string | null {
  if (!usps) return null;
  return USPS_TO_FIPS[usps.toUpperCase()] ?? null;
}

/**
 * Convert a FIPS code to USPS. Returns null for unknown codes.
 */
export function fipsToUsps(fips: string | null | undefined): string | null {
  if (!fips) return null;
  return FIPS_TO_USPS[fips] ?? null;
}
