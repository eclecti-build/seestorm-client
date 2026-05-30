// Regional groupings for the drill-down location picker.
//
// The picker shows a stylized map of the lower 48 first; tapping a region
// narrows 55 supported codes down to a handful before the user picks a state.
// This module is the single source of truth for *which* state belongs to
// *which* region, and for the GeoJSON-name → USPS-code lookup the map SVG
// needs to colour each feature.
//
// Kept dependency-free (no React, no fetch) like coverage.ts so it can be
// imported by the map component, the chip, and pure tests alike. The set of
// codes here must stay in sync with COVERAGE: regions.test.ts enforces that
// every supported code is reachable through exactly one region or OFFSHORE.

import { COVERAGE, STATE_NAMES } from './coverage';

export type RegionId =
  | 'west'
  | 'mountain'
  | 'plains'
  | 'midwest'
  | 'south'
  | 'midatlantic'
  | 'newengland';

export interface Region {
  readonly id: RegionId;
  /** Short human label shown on the region tile and drill-down header. */
  readonly label: string;
  /** One-line orientation hint shown under the region title. */
  readonly blurb: string;
  /** USPS codes that belong to this region, roughly north-to-south. */
  readonly members: ReadonlyArray<string>;
}

/**
 * The seven contiguous regions, ordered west → east. Groupings are
 * weather-/geography-sensible rather than strict Census divisions: they keep
 * the Great Lakes home turf together and split the dense Northeast into
 * Mid-Atlantic + New England so every drill-down list stays a comfortable
 * 4–10 states.
 */
export const REGIONS: ReadonlyArray<Region> = Object.freeze([
  {
    id: 'west',
    label: 'West',
    blurb: 'Pacific coast & Nevada',
    members: Object.freeze(['WA', 'OR', 'CA', 'NV']),
  },
  {
    id: 'mountain',
    label: 'Mountain',
    blurb: 'Rockies & desert Southwest',
    members: Object.freeze(['ID', 'MT', 'WY', 'UT', 'CO', 'AZ', 'NM']),
  },
  {
    id: 'plains',
    label: 'Plains',
    blurb: 'Tornado Alley & the High Plains',
    members: Object.freeze(['ND', 'SD', 'NE', 'KS', 'OK', 'TX']),
  },
  {
    id: 'midwest',
    label: 'Great Lakes',
    blurb: 'Upper Midwest & Ohio Valley',
    members: Object.freeze(['MN', 'WI', 'MI', 'IA', 'IL', 'IN', 'OH', 'MO']),
  },
  {
    id: 'south',
    label: 'South',
    blurb: 'Gulf Coast & Southeast',
    members: Object.freeze(['KY', 'TN', 'AR', 'LA', 'MS', 'AL', 'GA', 'FL', 'SC', 'NC']),
  },
  {
    id: 'midatlantic',
    label: 'Mid-Atlantic',
    blurb: 'New York to Virginia',
    members: Object.freeze(['NY', 'NJ', 'PA', 'DE', 'MD', 'DC', 'VA', 'WV']),
  },
  {
    id: 'newengland',
    label: 'New England',
    blurb: 'The six northeastern states',
    members: Object.freeze(['CT', 'RI', 'MA', 'VT', 'NH', 'ME']),
  },
]) as ReadonlyArray<Region>;

/**
 * Codes that have no place on the lower-48 silhouette — Alaska, Hawaii, and
 * the five territories. The picker surfaces these as a separate chip row so
 * they stay reachable without distorting the map projection.
 */
export const OFFSHORE: ReadonlyArray<string> = Object.freeze([
  'AK',
  'HI',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
]);

/** USPS code → region id, for the contiguous members only. */
export const STATE_TO_REGION: Readonly<Record<string, RegionId>> = Object.freeze(
  REGIONS.reduce<Record<string, RegionId>>((acc, region) => {
    for (const code of region.members) acc[code] = region.id;
    return acc;
  }, {}),
);

/** Full state name → USPS code, inverting STATE_NAMES for GeoJSON lookups. */
export const NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(STATE_NAMES).reduce<Record<string, string>>((acc, [code, name]) => {
    acc[name] = code;
    return acc;
  }, {}),
);

/** The region a contiguous code belongs to, or null for offshore/unknown. */
export function regionForCode(code: string): Region | null {
  const id = STATE_TO_REGION[code];
  if (!id) return null;
  return REGIONS.find((r) => r.id === id) ?? null;
}

// Membership guard mirroring isSupportedState, scoped to drill-down reachability.
export function isReachable(code: string): boolean {
  return COVERAGE.includes(code as (typeof COVERAGE)[number]);
}
