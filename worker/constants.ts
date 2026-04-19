/**
 * Cache-Control constants for the Worker's `/v1/*` public surface.
 *
 * Extracted from `worker/index.ts` so the four header values live in one
 * place and stay byte-identical to the audit contract
 * (docs/SWARM_AUDIT_2026-04-18.md — "Constants — paste-ready"). Drift
 * between these and the audit would show up as either thundering-herd
 * risk (missing SWR) or under-caching of long-lived objects (history).
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
 * The /v1/geo answer is per-IP (CF derives from the requesting IP), so
 * the edge cache is scoped by that upstream; a 5-minute s-maxage plus
 * SWR keeps latency flat for a metro-sized burst of clients on the
 * same egress.
 */

export const LIVE_CACHE_CONTROL = 'public, max-age=30, s-maxage=60, stale-while-revalidate=30';

export const LIST_CACHE_CONTROL = 'public, max-age=60, s-maxage=60, stale-while-revalidate=60';

export const HISTORY_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const GEO_CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=60';
