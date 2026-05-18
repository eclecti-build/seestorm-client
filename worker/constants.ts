/**
 * Cache-Control constants for the Worker's `/v1/*` public surface.
 *
 * Extracted from `worker/index.ts` so the four header values live in one
 * place. Drift here shows up as thundering-herd risk (missing SWR),
 * under-caching of long-lived objects (history), or privacy risk
 * (/v1/geo becoming cacheable).
 *
 * Why SWR on the live endpoint: ingest rewrites `active-events.json`
 * every 30s. With `max-age=30, s-maxage=60, stale-while-revalidate=30`,
 * the edge serves the cached object to all concurrent clients while a
 * single in-flight revalidation repopulates it — collapsing the TTL-
 * rollover fan-out from N concurrent R2 GETs to 1.
 *
 * History objects are keyed by immutable timestamp, so a year-long
 * immutable cache is safe and eliminates revalidation cost entirely
 * for the slider-scrub path.
 *
 * The /v1/geo answer is derived from the requesting IP and may contain
 * ZIP/state/lat/lon. It must never be stored in a browser cache or shared
 * edge cache.
 */

export const LIVE_CACHE_CONTROL = 'public, max-age=30, s-maxage=60, stale-while-revalidate=30';

export const LIST_CACHE_CONTROL = 'public, max-age=60, s-maxage=60, stale-while-revalidate=60';

export const HISTORY_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const GEO_CACHE_CONTROL = 'private, no-store';
