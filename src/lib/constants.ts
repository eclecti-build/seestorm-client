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

export const STALENESS_BANNER_COPY =
  'Live data is delayed. For active severe weather, check NWS.gov or NOAA Weather Radio.';
