// Single source of truth for supported state/territory codes, their
// approximate geographic centers, and regional groupings. The manual picker
// (LocationChip), IP-based first-visit default (geoDefault.ts), and alert
// filtering all read from here so the supported-set is never inconsistent.
//
// Kept dependency-free (no React, no fetch) so it can be imported by both
// runtime components and pure helpers/tests without dragging React in.

/**
 * USPS code → approximate geographic center for all 50 US states + DC + 5
 * territories. Used for manual picks (LocationChip) and the IP-derived
 * first-visit default (geoDefault). Pairs with `STATE_VIEW_ZOOM` for fly-to.
 */
export const STATE_CENTERS: Readonly<Record<string, { lat: number; lon: number }>> = Object.freeze({
  AL: { lat: 32.8, lon: -86.8 },
  AK: { lat: 64.2, lon: -152.5 },
  AZ: { lat: 34.3, lon: -111.7 },
  AR: { lat: 34.8, lon: -92.2 },
  CA: { lat: 37.2, lon: -119.5 },
  CO: { lat: 39.0, lon: -105.5 },
  CT: { lat: 41.6, lon: -72.7 },
  DC: { lat: 38.9, lon: -77.0 },
  DE: { lat: 39.0, lon: -75.5 },
  FL: { lat: 28.6, lon: -82.5 },
  GA: { lat: 32.7, lon: -83.5 },
  HI: { lat: 20.8, lon: -156.3 },
  ID: { lat: 44.4, lon: -114.6 },
  IL: { lat: 40.0, lon: -89.0 },
  IN: { lat: 39.9, lon: -86.3 },
  IA: { lat: 42.0, lon: -93.6 },
  KS: { lat: 38.5, lon: -98.3 },
  KY: { lat: 37.8, lon: -85.3 },
  LA: { lat: 31.0, lon: -92.0 },
  ME: { lat: 45.4, lon: -69.2 },
  MD: { lat: 39.0, lon: -76.8 },
  MA: { lat: 42.3, lon: -71.8 },
  MI: { lat: 44.3, lon: -85.6 },
  MN: { lat: 46.3, lon: -94.3 },
  MS: { lat: 32.7, lon: -89.7 },
  MO: { lat: 38.4, lon: -92.5 },
  MT: { lat: 47.1, lon: -109.6 },
  NE: { lat: 41.5, lon: -99.8 },
  NV: { lat: 39.3, lon: -116.6 },
  NH: { lat: 43.7, lon: -71.6 },
  NJ: { lat: 40.1, lon: -74.7 },
  NM: { lat: 34.4, lon: -106.1 },
  NY: { lat: 42.9, lon: -75.5 },
  NC: { lat: 35.6, lon: -79.8 },
  ND: { lat: 47.5, lon: -100.5 },
  OH: { lat: 40.4, lon: -82.8 },
  OK: { lat: 35.6, lon: -97.5 },
  OR: { lat: 43.9, lon: -120.6 },
  PA: { lat: 40.9, lon: -77.8 },
  RI: { lat: 41.7, lon: -71.5 },
  SC: { lat: 33.9, lon: -80.9 },
  SD: { lat: 44.4, lon: -100.2 },
  TN: { lat: 35.9, lon: -86.4 },
  TX: { lat: 31.5, lon: -99.3 },
  UT: { lat: 39.3, lon: -111.7 },
  VT: { lat: 44.1, lon: -72.6 },
  VA: { lat: 37.5, lon: -78.9 },
  WA: { lat: 47.4, lon: -120.5 },
  WV: { lat: 38.6, lon: -80.6 },
  WI: { lat: 44.5, lon: -89.5 },
  WY: { lat: 43.0, lon: -107.6 },
  // Territories
  AS: { lat: -14.3, lon: -170.7 },
  GU: { lat: 13.4, lon: 144.8 },
  MP: { lat: 15.2, lon: 145.7 },
  PR: { lat: 18.2, lon: -66.5 },
  VI: { lat: 18.3, lon: -64.8 },
});

/**
 * Ordered list of all supported state/territory codes — drives the
 * LocationChip picker and is also used as the supported-set guard for
 * IP-derived defaults. Alphabetical within the full set.
 */
export const COVERAGE: ReadonlyArray<keyof typeof STATE_CENTERS> = Object.freeze([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DC',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'AS',
  'GU',
  'MP',
  'PR',
  'VI',
]) as ReadonlyArray<keyof typeof STATE_CENTERS>;

export const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DC: 'District of Columbia',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  AS: 'American Samoa',
  GU: 'Guam',
  MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico',
  VI: 'US Virgin Islands',
});

/**
 * Zoom that fits a single state in the viewport. The old ZIP flow used
 * level 8 (≈ city/county) which is too tight when we can only resolve to
 * state granularity.
 */
export const STATE_VIEW_ZOOM = 6;

/**
 * True when the input is one of the supported USPS codes (case-sensitive,
 * uppercase). Centralized so geoDefault and any future entry point share
 * the same membership check.
 */
export function isSupportedState(usps: string): usps is keyof typeof STATE_CENTERS {
  return Object.prototype.hasOwnProperty.call(STATE_CENTERS, usps);
}
