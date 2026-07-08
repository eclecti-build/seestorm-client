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
 * `stale-if-error=300` on LIVE and LIST lets the edge keep serving the
 * last-good cached response for up to 5 minutes if R2 (or this Worker's
 * own logic) starts erroring, instead of surfacing a 503 to every client
 * hitting that edge node during the outage. The client-side staleness
 * banner (STALENESS_CRITICAL_MS, 90s) still fires regardless of what's
 * serving the response, so this trades a harder failure for a clearly
 * communicated stale one. Not applied to HISTORY (immutable, nothing to
 * revalidate) or GEO (must never be cached at all).
 *
 * The /v1/geo answer is derived from the requesting IP and may contain
 * ZIP/state/lat/lon. It must never be stored in a browser cache or shared
 * edge cache.
 */

export const LIVE_CACHE_CONTROL =
  'public, max-age=30, s-maxage=60, stale-while-revalidate=30, stale-if-error=300';

export const LIST_CACHE_CONTROL =
  'public, max-age=60, s-maxage=60, stale-while-revalidate=60, stale-if-error=300';

export const HISTORY_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const GEO_CACHE_CONTROL = 'private, no-store';
