// Client-wide tuning constants for the airtight refresh loop + staleness
// detection system (swarm audit 2026-04-18, Tier 1 #2c; Open Decisions #11).
//
// Pasted verbatim from the "Constants — paste-ready" Client (TypeScript) block
// in docs/SWARM_AUDIT_2026-04-18.md so that any ingest/Worker/client number
// that must match is sourced from one place. Do not edit these values without
// reconciling against the audit doc first.

export const POLL_INTERVAL_MS = 30_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;
export const FETCH_RETRY_MAX_ATTEMPTS = 3;

export const STALENESS_CRITICAL_MS = 90_000;

/**
 * Consecutive failed LIVE fetch attempts (fetchLive's catch path in
 * WeatherMap.tsx, after fetchWithRetry's internal retries are already
 * exhausted) before AlertsPanel shows the "Alert data unavailable" degraded
 * notice instead of "No active alerts." 2 cycles at POLL_INTERVAL_MS = 30s is
 * up to 60s of persistent failure — long enough that a single blip doesn't
 * flash the notice (fetchWithRetry already absorbs single blips internally
 * via its own 250/1000/2000ms backoff), short enough that a real outage is
 * surfaced well before a user gives up, and — unlike the staleness banner,
 * which requires a PRIOR success to have a `generatedAtMs` to compare
 * against — it can fire on a session that has never had one.
 */
export const FETCH_DEGRADED_THRESHOLD = 2;

export const STALENESS_BANNER_COPY =
  'Live data is delayed. For active severe weather, check NWS.gov or NOAA Weather Radio.';
