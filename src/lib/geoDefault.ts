// First-visit IP-based default for the state picker.
//
// On a brand-new visit (no saved UserLocation in localStorage) we ask the
// Worker's `/v1/geo` endpoint what state the requesting IP appears to be in.
// If the answer is one of the supported states, we silently
// pre-fill the picker so the user lands on a sensible default instead of an
// empty map. Any failure mode (bad fetch, missing field, unsupported state,
// timeout) is a silent no-op — the picker stays empty, exactly matching
// post-county-fix behavior, and the user can pick manually.
//
// This module deliberately does NOT touch any UI: it only reads/writes
// localStorage via `userLocation.ts`. Components that need to react to a
// newly-set default subscribe via `useUserLocation` (which fires on the
// `seestorm:user-location-changed` event that `setUserLocation` emits).
//
// Manual picks always supersede this — `LocationChip.handlePick` writes
// `source: 'manual'`, and `getUserLocation` is checked first here, so
// returning visitors never re-trigger the IP fetch.

import { COVERAGE, STATE_CENTERS, isSupportedState } from './coverage';
import { getUserLocation, setUserLocation, type UserLocation } from './userLocation';

/**
 * Shape returned by the Worker's `/v1/geo` endpoint. `state` is a USPS
 * 2-letter code (e.g. "WI") — see the worker's `serveGeoSuggestion` for the
 * source field. `state` may be empty when CF couldn't infer a region for
 * the requesting IP (corporate proxies, recently-changed allocations).
 */
export interface GeoSuggestion {
  zip: string;
  state: string;
  lat: number | null;
  lon: number | null;
}

/** Hard cap on how long we'll wait for `/v1/geo` before giving up. */
export const DEFAULT_GEO_TIMEOUT_MS = 1500;

interface ApplyGeoDefaultOptions {
  /**
   * Override the global `fetch` — used by tests to inject a mock without
   * leaking through to other test files via vi.stubGlobal.
   */
  fetchImpl?: typeof fetch;
  /** Timeout for the /v1/geo request. Default 1.5s — see task spec. */
  timeoutMs?: number;
  /**
   * Override the wall clock for `setAt`. Tests pin this so they can assert
   * the exact stored value without freezing global Date.
   */
  now?: () => number;
}

/**
 * Validate the `/v1/geo` payload shape. Worker is well-behaved but the
 * client should not crash if a future field type drifts (or if a CDN bug
 * serves a stale shape) — we treat any non-conforming response as "no
 * suggestion available" and fall back to the empty-picker default.
 */
function isGeoSuggestion(value: unknown): value is GeoSuggestion {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.zip === 'string' &&
    typeof v.state === 'string' &&
    (v.lat === null || typeof v.lat === 'number') &&
    (v.lon === null || typeof v.lon === 'number')
  );
}

/**
 * Fetch `/v1/geo` and return a fully-formed `UserLocation` (with
 * `source: 'ip'`) iff the inferred state is one of the supported codes.
 * Returns null on any failure — network error, non-2xx, malformed body,
 * empty/unsupported state, or timeout. Never throws.
 *
 * The lat/lon on the returned location are pulled from `STATE_CENTERS`
 * (the agreed state-level fly-to points), NOT from the IP-derived
 * coordinates — those can be off by hundreds of miles for some carriers
 * and would yank the map to a misleading spot. State granularity is the
 * agreed precision for IP-based defaults.
 */
export async function fetchGeoSuggestion(
  options: ApplyGeoDefaultOptions = {},
): Promise<UserLocation | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEO_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let payload: unknown;
  try {
    const response = await fetchImpl('/v1/geo', { signal: controller.signal });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    // Abort, network failure, or JSON parse error — all treated identically.
    // No console.error: the spec calls for silent degradation so the
    // first-visit experience is never noisier than the no-default baseline.
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!isGeoSuggestion(payload)) return null;
  const usps = payload.state.toUpperCase();
  if (!isSupportedState(usps)) return null;

  const center = STATE_CENTERS[usps];
  return {
    state: usps,
    lat: center.lat,
    lon: center.lon,
    source: 'ip',
    setAt: now(),
  };
}

/**
 * Result of `applyGeoDefaultIfNeeded`. The caller (typically WeatherMap)
 * uses this to decide whether to fly the map to the IP-inferred state and
 * apply the per-state county filter.
 *
 * `kind: 'saved'` — a manual or previously-applied IP default already exists;
 *                   nothing was fetched, no-op for the caller.
 * `kind: 'applied'` — IP fetch succeeded and we wrote a new default.
 * `kind: 'none'` — IP fetch failed or returned an unsupported state; the
 *                  picker remains empty and the caller should not fly.
 */
export type GeoDefaultOutcome =
  | { kind: 'saved'; location: UserLocation }
  | { kind: 'applied'; location: UserLocation }
  | { kind: 'none' };

/**
 * If the user has no saved location, fetch `/v1/geo` and persist a new
 * `source: 'ip'` default when the inferred state is supported. Idempotent
 * across calls — repeat invocations after a successful default short-circuit
 * via the `getUserLocation` check.
 *
 * The persisted location fires the standard `seestorm:user-location-changed`
 * event, so any component using `useUserLocation` (e.g. LocationChip) re-
 * renders without extra wiring.
 *
 * Caller must still react to the returned outcome to update non-localStorage
 * state (e.g. the WeatherMap's userStateRef + map fly + county filter).
 */
export async function applyGeoDefaultIfNeeded(
  options: ApplyGeoDefaultOptions = {},
): Promise<GeoDefaultOutcome> {
  const existing = getUserLocation();
  if (existing) return { kind: 'saved', location: existing };

  const inferred = await fetchGeoSuggestion(options);
  if (!inferred) return { kind: 'none' };

  setUserLocation(inferred);
  return { kind: 'applied', location: inferred };
}

/**
 * Re-export for tests and any future caller that wants the supported set
 * without taking a transitive dep on `coverage.ts`.
 */
export { COVERAGE };
