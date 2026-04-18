// USPS ↔ FIPS state-code mapping for the 8 Great Lakes states SeeStorm covers.
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
 * USPS → FIPS for the 8 supported states. Other USPS codes return undefined.
 */
export const USPS_TO_FIPS: Readonly<Record<string, string>> = Object.freeze({
  IL: '17',
  IN: '18',
  MI: '26',
  MN: '27',
  NY: '36',
  OH: '39',
  PA: '42',
  WI: '55',
});

/**
 * FIPS → USPS for the 8 supported states. Useful when reading `STATE` off a
 * county feature for logging or debug surfaces.
 */
export const FIPS_TO_USPS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(USPS_TO_FIPS).map(([usps, fips]) => [fips, usps])),
);

/**
 * Convert a USPS code to FIPS. Returns null for unknown codes (out of
 * SeeStorm scope) so callers can decide to skip a filter rather than crash.
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
