// Single source of truth for the 9 supported state codes and their
// approximate geographic centers. Both the manual picker (`LocationChip`)
// and the IP-based first-visit default (`geoDefault.ts`) read from here so
// the two paths can never disagree on which states are "supported" or where
// to fly the map when a state is selected.
//
// Kept dependency-free (no React, no fetch) so it can be imported by both
// runtime components and pure helpers/tests without dragging React in.

/**
 * USPS code → approximate geographic center for the 9 covered states
 * (Great Lakes 8 + Iowa).
 * Used both for manual picks (LocationChip) and for the IP-derived first-
 * visit default (geoDefault). Pairs with `STATE_VIEW_ZOOM` for fly-to.
 */
export const STATE_CENTERS: Readonly<Record<string, { lat: number; lon: number }>> = Object.freeze({
  MN: { lat: 46.3, lon: -94.3 },
  WI: { lat: 44.5, lon: -89.5 },
  IA: { lat: 42.0308, lon: -93.5805 },
  IL: { lat: 40.0, lon: -89.0 },
  IN: { lat: 39.9, lon: -86.3 },
  MI: { lat: 44.3, lon: -85.6 },
  OH: { lat: 40.4, lon: -82.8 },
  PA: { lat: 40.9, lon: -77.8 },
  NY: { lat: 42.9, lon: -75.5 },
});

/**
 * Ordered list of supported state codes — drives the LocationChip grid layout
 * (so the visual order is stable across renders) and is also used as the
 * supported-set guard for IP-derived defaults. Ordering is roughly west→east
 * across the band; IA slots between MN/WI and IL/IN geographically.
 */
export const COVERAGE: ReadonlyArray<keyof typeof STATE_CENTERS> = Object.freeze([
  'MN',
  'WI',
  'IA',
  'IL',
  'IN',
  'MI',
  'OH',
  'PA',
  'NY',
]) as ReadonlyArray<keyof typeof STATE_CENTERS>;

/**
 * Zoom that fits a single state in the viewport. The old ZIP flow used
 * level 8 (≈ city/county) which is too tight when we can only resolve to
 * state granularity.
 */
export const STATE_VIEW_ZOOM = 6;

/**
 * True when the input is one of the 9 supported USPS codes (case-sensitive,
 * uppercase). Centralized so geoDefault and any future entry point share
 * the same membership check.
 */
export function isSupportedState(usps: string): usps is keyof typeof STATE_CENTERS {
  return Object.prototype.hasOwnProperty.call(STATE_CENTERS, usps);
}
