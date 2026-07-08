/**
 * SeeStorm client Worker — public read proxy for private R2 snapshots.
 *
 * Architecture:
 *   Browser  →  this Worker  →  R2 bucket "seestorm-data" (private)
 *              ↳ static Next.js export (out/) for everything else
 *
 * The bucket has NO public access. Only this Worker (via the SNAPSHOTS binding)
 * and the ingest service (via its write-scoped API token) can reach objects.
 *
 * Public surface (all under /v1/ so the response schema can evolve):
 *   GET /v1/active-events.json       → current snapshot, overwritten every poll
 *   GET /v1/history                  → list of recent history snapshots
 *   GET /v1/history/{timestamp}      → one history snapshot; {timestamp} is
 *                                      YYYYMMDDTHHMMSSZ (e.g. 20260417T034500Z)
 */

import {
  LIVE_CACHE_CONTROL,
  LIST_CACHE_CONTROL,
  HISTORY_CACHE_CONTROL,
  GEO_CACHE_CONTROL,
} from './constants';

export interface Env {
  /** Binding to the `seestorm-data` R2 bucket. Read-only from this Worker. */
  SNAPSHOTS: R2Bucket;
  /** Binding to the bundled Next.js static export (./out). */
  ASSETS: Fetcher;
}

// Cache-Control values live in `./constants` so the four header strings stay
// in one place.
//
// LIVE now carries `stale-while-revalidate=30` — the thundering-herd mitigation
// at 30s TTL rollover. The edge serves cached bytes to every concurrent client
// while a single background fetch repopulates from R2, collapsing the worst-
// case fan-out from N concurrent R2 GETs to 1.
//
// LIST adds SWR for the same reason on the (pricier) R2 list class-A op.
// HISTORY stays immutable — archived timestamps never change content.
// GEO is deliberately `private, no-store`: it is derived from the
// requester's IP and can include ZIP/state/lat/lon, so it must never be
// shared-cacheable.

/** Compact RFC3339-like timestamp: 20060102T150405Z (matches ingest's key format). */
const TIMESTAMP_RE = /^\d{8}T\d{6}Z$/;

/**
 * USPS 2-letter state code, uppercase only. The per-state R2 keys use this
 * exact shape (`active-events/{STATE}.json`).
 *
 * Shape gate only — membership is enforced separately via
 * `PUBLIC_PER_STATE_SNAPSHOTS` at the route handler. This split keeps
 * `parsePerStateCode` a pure URL shape parser (used by focused unit tests)
 * while the code-reviewable coverage decision lives in one data structure.
 */
const STATE_CODE_RE = /^[A-Z]{2}$/;

// Explicit allowlist of per-state snapshot keys. Matches the ingest service's
// configured NWS_AREA. Adding a state here must be coordinated with ingest's
// NWS_AREA env so clients don't see 404s.
//
// This is the PUBLIC_SNAPSHOTS contract called out in CLAUDE.md: public API
// surface is versioned and the set of snapshot keys served is code-reviewable,
// not regex-derived.
export const PUBLIC_PER_STATE_SNAPSHOTS = new Set([
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
] as const);

/** Union of USPS codes currently served by the per-state route. */
export type PerStateCode = typeof PUBLIC_PER_STATE_SNAPSHOTS extends Set<infer T> ? T : never;

/**
 * Extract a per-state code from `/v1/active-events/{STATE}.json`. Returns
 * null for malformed paths (different segment count, lowercase, missing
 * extension, suspicious characters). Pure function — exported for test.
 */
export function parsePerStateCode(pathname: string): string | null {
  const prefix = '/v1/active-events/';
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  // Path must be exactly `{STATE}.json` — no nested segments, no query
  // soup, no Unicode, no path traversal. The `.json` requirement keeps
  // us symmetric with the merged endpoint URL shape.
  const match = tail.match(/^([A-Z]{2})\.json$/);
  if (!match) return null;
  if (!STATE_CODE_RE.test(match[1])) return null;
  return match[1];
}

/** Default history window returned by /v1/history — 2 hours at 30s polls = 240 snapshots. */
const HISTORY_DEFAULT_LIMIT = 240;
const HISTORY_MAX_LIMIT = 1000;

/**
 * CSP allowlist for SeeStorm. Shipped **Report-Only** first — see Open
 * Decision #9 in docs/SWARM_AUDIT_2026-04-18.md. Flip criteria:
 *   - ≥7 days elapsed in Report-Only AND
 *   - 48h zero-new-violation-type window observed AND
 *   - ≤14-day hard ceiling (if hit, tighten allowlist, don't extend window).
 *
 * Source: docs/LAUNCH_HARDENING.md:117-137 (runtime recon 2026-04-17).
 * `report-uri` is same-origin — see handleCspReport() below.
 */
const CSP_POLICY = [
  "default-src 'self'",
  // Next.js RSC hydration emits inline scripts. Replace with nonce-based
  // policy via middleware as a follow-up hardening pass.
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  // Tailwind / component inline styles.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // Inter is self-hosted via next/font; Google Fonts pulled in by next/font/google.
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://mesonet.agron.iastate.edu https://tiles.stadiamaps.com https://data.seestorm.org",
  // MapLibre geojson-vt spawns a blob: worker for tile parsing.
  'worker-src blob:',
  // Upstreams: Iowa Mesonet radar, CartoDB basemap (bare host serves
  // style.json; wildcard covers tiles-{a..d}.basemaps.cartocdn.com shard
  // rotations — CSP wildcards do NOT match the apex, so both are required),
  // Stadia-compatible basemap override, SeeStorm R2-backed Protomaps
  // (subdomain provisioned by Sean — CAA on seestorm.org limits issuance
  // to LE + GTS), and Cloudflare Web Analytics beacon auto-injected by
  // Workers.
  "connect-src 'self' https://mesonet.agron.iastate.edu https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com https://tiles.stadiamaps.com https://data.seestorm.org https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'report-uri /csp-report',
].join('; ');

/**
 * Apply the baseline security headers to ANY response. These are browser-
 * interpretation hints that are safe on binary and JSON responses alike.
 *
 * HSTS + X-Content-Type-Options + Referrer-Policy + Permissions-Policy apply
 * universally (they don't trigger content parsing side-effects). X-Frame-
 * Options is included here too — clickjacking protection is cheap and our
 * R2-proxied JSON would never be legitimately framed.
 */
function applyBaselineSecurityHeaders(headers: Headers): void {
  // HSTS — preload-eligible (max-age ≥ 1yr, includeSubDomains, preload). One-
  // time registration at hstspreload.org AFTER verifying subdomains are HTTPS.
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('permissions-policy', 'geolocation=(self), microphone=(), camera=()');
}

/**
 * Apply CSP in Report-Only to responses where a browser might execute content
 * (HTML pages, JSON consumed by JS). Deliberately Report-Only — do NOT add
 * the enforcing `Content-Security-Policy` header here. See CSP_POLICY for
 * the flip criteria.
 */
function applyCspReportOnly(headers: Headers): void {
  headers.set('content-security-policy-report-only', CSP_POLICY);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CSP violation reporter — same-origin POST target declared in the
    // CSP's report-uri. Handle before `/v1/` so the route stays distinct
    // from the versioned public API surface.
    if (url.pathname === '/csp-report') {
      return handleCspReport(request);
    }

    if (url.pathname.startsWith('/v1/')) {
      return handleApiRequest(request, url, env);
    }

    // Anything not under /v1/ is static Next.js content. Wrap the ASSETS
    // response so security headers land on every HTML page (the primary
    // CSP target), 404 pages, and the root document.
    const assetResponse = await env.ASSETS.fetch(request);
    const wrapped = new Response(assetResponse.body, assetResponse);
    applyBaselineSecurityHeaders(wrapped.headers);
    applyCspReportOnly(wrapped.headers);
    return wrapped;
  },
} satisfies ExportedHandler<Env>;

async function handleApiRequest(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed();
  }

  // /v1/active-events.json — the merged multi-state snapshot.
  if (url.pathname === '/v1/active-events.json') {
    return serveObject(request, env, 'active-events.json', LIVE_CACHE_CONTROL);
  }

  // /v1/active-events/{STATE}.json — per-state snapshot. Lets clients that
  // care about a subset of states (e.g. a user with a saved ZIP) fetch only
  // the slice they need instead of the full multi-state payload. Same cache
  // contract as the merged endpoint — the ingest writes both at the same
  // 30s cadence with identical cache headers.
  //
  // Allowlist check happens BEFORE any R2 call so out-of-coverage codes
  // short-circuit to 404 without burning a class-B op. States in the
  // allowlist but missing from R2 (e.g. transient ingest outage) still
  // 404 via the usual serveObject path — both branches end at 404 with
  // the full baseline security header set.
  const stateCode = parsePerStateCode(url.pathname);
  if (stateCode !== null) {
    if (!PUBLIC_PER_STATE_SNAPSHOTS.has(stateCode as PerStateCode)) {
      return notFound('state not available');
    }
    return serveObject(request, env, `active-events/${stateCode}.json`, LIVE_CACHE_CONTROL);
  }

  // /v1/geo — best-effort suggested location from the CF edge metadata. The
  // client can use this to pre-fill the LocationBanner ZIP input or to skip
  // the prompt entirely when a confident match is available. This is a
  // SUGGESTION, not authoritative — the user always wins via manual input.
  if (url.pathname === '/v1/geo') {
    return serveGeoSuggestion(request);
  }

  // /v1/history — JSON index of recent history snapshots.
  if (url.pathname === '/v1/history') {
    return serveHistoryList(request, url, env);
  }

  // /v1/history/{timestamp} — specific archived snapshot.
  if (url.pathname.startsWith('/v1/history/')) {
    const ts = url.pathname.slice('/v1/history/'.length);
    if (!TIMESTAMP_RE.test(ts)) {
      return notFound();
    }
    return serveObject(request, env, `history/${ts}.json`, HISTORY_CACHE_CONTROL);
  }

  return notFound();
}

/**
 * Fetch an R2 object and stream it back, honoring If-None-Match for 304 responses.
 */
async function serveObject(
  request: Request,
  env: Env,
  key: string,
  cacheControl: string,
): Promise<Response> {
  // Strip surrounding double-quotes and the optional weak-etag prefix before
  // handing the value to R2. Browsers send the header in its canonical quoted
  // form per RFC 7232 §2.3 (e.g. `If-None-Match: "abc"` or `W/"abc"`), but
  // R2's `etagDoesNotMatch` expects the raw hash — passing the quoted form
  // throws inside the binding and surfaces as a Cloudflare 1101 (Worker
  // exception) to the client. Normalizing here keeps the 304 fast-path working
  // for every HTTP client that follows the spec.
  const ifNoneMatch = request.headers
    .get('if-none-match')
    ?.trim()
    .replace(/^W\//i, '')
    .replace(/^"(.*)"$/, '$1');
  let object: Awaited<ReturnType<R2Bucket['get']>>;
  try {
    object = await env.SNAPSHOTS.get(key, {
      onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'r2_get_failed', key, error: errorMessage(err) }));
    return serviceUnavailable();
  }

  if (object === null) {
    return notFound();
  }

  const headers = buildObjectHeaders(object, cacheControl);

  // R2 returns an R2ObjectBody on fetch, or a plain R2Object when the
  // conditional was satisfied (etag matched) — signal 304 to the client.
  if (!('body' in object)) {
    return new Response(null, { status: 304, headers });
  }

  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}

/**
 * List historical snapshots. Response shape:
 *   { snapshots: [{ ts: "20260417T034500Z", generated_at: "2026-04-17T03:45:00Z" }, ...] }
 *
 * Returned in descending chronological order (newest first) so the client can
 * render the slider without re-sorting. Default window is the last
 * HISTORY_DEFAULT_LIMIT snapshots; `?limit=N` overrides up to HISTORY_MAX_LIMIT.
 */
async function serveHistoryList(request: Request, url: URL, env: Env): Promise<Response> {
  const limitParam = url.searchParams.get('limit');
  let limit = HISTORY_DEFAULT_LIMIT;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0) {
      limit = Math.min(n, HISTORY_MAX_LIMIT);
    }
  }

  let snapshots: HistoryEntry[];
  try {
    snapshots = await listNewestHistoryEntries(env.SNAPSHOTS, limit);
  } catch (err) {
    const message = errorMessage(err);
    const isContractViolation = message.startsWith('listNewestHistoryEntries:');
    console.error(
      JSON.stringify({
        event: isContractViolation ? 'history_list_contract_violation' : 'history_list_failed',
        error: message,
      }),
    );
    return isContractViolation ? internalError() : serviceUnavailable();
  }

  const body = JSON.stringify({
    snapshots,
    count: snapshots.length,
  });

  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': LIST_CACHE_CONTROL,
  });
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return new Response(body, { headers });
}

/** Minimum surface of R2Bucket needed for listing — kept narrow for testability. */
export type R2BucketListOnly = Pick<R2Bucket, 'list'>;

/** R2 list page size — the per-page maximum the Workers runtime supports. */
const R2_LIST_PAGE_SIZE = 1000;

/** Cadence at which ingest writes history snapshots (seconds). */
const HISTORY_INTERVAL_SECONDS = 30;

/**
 * Safety multiplier on the bounded list window. Scanning 50% more keys than
 * the caller asked for is cheap in R2 terms and absorbs ingest gaps plus
 * clock skew between Worker and ingest (both NTP-synced, so skew is
 * effectively sub-second — the margin is for missed 30 s slots).
 */
const HISTORY_WINDOW_MULTIPLIER = 1.5;

/**
 * Lower bound on the scanned window, for small-limit pathological cases
 * (limit=1 would otherwise only look back 45 s, which is narrower than one
 * ingest gap). 15 min gives any plausible small request enough slack.
 */
const HISTORY_MIN_WINDOW_SECONDS = 15 * 60;

/**
 * Return the newest `limit` history entries in descending chronological order.
 *
 * R2 only returns keys in ascending lexicographic order and has no native
 * "list from the end" option. We exploit the fact that history keys are
 * lex-sortable timestamps (YYYYMMDDTHHMMSSZ) to set `startAfter` to the
 * timestamp just before the window we care about — R2 seeks directly to that
 * position, so list cost is bounded by window size, not bucket size. At the
 * default limit of 240 (2 h slider) this scans ~360 keys — one R2 page, one
 * class-A op — regardless of how long history has been retained.
 *
 * `now` is injectable for deterministic tests. In production it defaults to
 * the current wall-clock time; ingest is NTP-synced so Worker and producer
 * agree on "now" within sub-second tolerance.
 */
export async function listNewestHistoryEntries(
  bucket: R2BucketListOnly,
  limit: number,
  now: Date = new Date(),
): Promise<HistoryEntry[]> {
  if (limit <= 0) return [];

  const windowSeconds = Math.max(
    limit * HISTORY_INTERVAL_SECONDS * HISTORY_WINDOW_MULTIPLIER,
    HISTORY_MIN_WINDOW_SECONDS,
  );
  const windowStart = new Date(now.getTime() - windowSeconds * 1000);

  // startAfter is lexicographic and exclusive. The stem (no ".json" suffix)
  // sorts BEFORE any real key at the same timestamp because '.' (0x2E) is
  // less than every digit — so this seeks to exactly "keys at or after
  // windowStart", inclusive of any key whose timestamp equals windowStart.
  const startAfter = `history/${formatHistoryTimestamp(windowStart)}`;

  // The window bound (limit × cadence × multiplier) is the load ceiling;
  // at HISTORY_MAX_LIMIT=1000 the worst case is ~1500 keys = 2 pages. A
  // hard page cap is defense-in-depth against upstream bugs (R2 contract
  // violation, window mis-sized) rather than a load limiter — hitting it
  // means something is wrong, not that there's "a lot of history". We
  // throw so it surfaces in CF analytics instead of silently truncating.
  const MAX_LIST_PAGES = 4;

  const tail: HistoryEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    // Pass startAfter only on the first call; subsequent pages use cursor.
    // R2 treats cursor + startAfter as an error / cursor-wins ambiguity, so
    // avoid sending both.
    const page: R2Objects = await bucket.list({
      prefix: 'history/',
      limit: R2_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : { startAfter }),
    });

    for (const object of page.objects) {
      const parsed = parseHistoryKey(object.key);
      if (parsed === null) continue;
      tail.push(parsed);
      if (tail.length > limit) tail.shift();
    }

    // R2 contract: `truncated === true` implies a `cursor` is returned.
    // Defend against a violation — without this guard the loop would
    // re-send `startAfter` forever and spin on the same page.
    if (page.truncated && !page.cursor) {
      throw new Error('listNewestHistoryEntries: R2 returned truncated=true without a cursor');
    }

    cursor = page.truncated ? page.cursor : undefined;
    pages += 1;

    if (pages > MAX_LIST_PAGES) {
      throw new Error(
        `listNewestHistoryEntries: exceeded ${MAX_LIST_PAGES} pages ` +
          `(limit=${limit}, windowSeconds=${windowSeconds}, nowIso=${now.toISOString()})`,
      );
    }
  } while (cursor);

  return tail.reverse();
}

/** Pad an integer to at least `w` digits with leading zeros. */
function padInt(n: number, w = 2): string {
  return n.toString().padStart(w, '0');
}

/**
 * Format a Date as the compact timestamp ingest uses for history keys
 * (YYYYMMDDTHHMMSSZ). Kept local to the Worker — ingest owns the canonical
 * format in Go and this mirrors it.
 */
function formatHistoryTimestamp(d: Date): string {
  return (
    padInt(d.getUTCFullYear(), 4) +
    padInt(d.getUTCMonth() + 1) +
    padInt(d.getUTCDate()) +
    'T' +
    padInt(d.getUTCHours()) +
    padInt(d.getUTCMinutes()) +
    padInt(d.getUTCSeconds()) +
    'Z'
  );
}

interface HistoryEntry {
  ts: string;
  generated_at: string;
}

/**
 * Parse `history/YYYYMMDDTHHMMSSZ.json` into { ts, generated_at }.
 * Returns null if the key is malformed (shouldn't happen — ingest owns the format —
 * but defend against stray manually-uploaded objects).
 */
function parseHistoryKey(key: string): HistoryEntry | null {
  const match = key.match(/^history\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  const ts = `${y}${m}${d}T${hh}${mm}${ss}Z`;
  const generated_at = `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
  return { ts, generated_at };
}

/**
 * Build a `{zip, state, lat, lon}` suggestion from `request.cf` (Cloudflare
 * IP geolocation metadata). Fields can be missing or empty for some clients
 * (corporate proxies, recently-changed allocations) — we return whatever we
 * have and let the client decide whether the suggestion is good enough to
 * pre-fill.
 *
 * `state` is the USPS 2-letter code (`cf.regionCode`, e.g. "WI") — NOT the
 * full region name (`cf.region` — "Wisconsin"). The client compares this
 * against its USPS-keyed coverage map (MN/WI/IA/IL/IN/MI/OH/PA/NY) to decide
 * whether to pre-fill the picker, so the code form is the only one that
 * actually matches against supported states.
 *
 * The IP-derived ZIP is the *postal code at the IP geolocation endpoint*,
 * which is sometimes a regional code, not the user's actual home ZIP. The
 * client UI must label this as a "guess" rather than treating it as
 * authoritative — see LocationBanner for the manual-override path.
 *
 * Exported for unit testing — the prod call site (`/v1/geo`) is the only
 * runtime caller, but inverting control here lets tests inject a synthetic
 * `request.cf` without standing up a Workers runtime fixture.
 */
export function serveGeoSuggestion(request: Request): Response {
  // Cloudflare's typed `request.cf` is `IncomingRequestCfProperties`. Some
  // fields (postalCode, regionCode, region) are documented as `string` but
  // can be empty for clients CF can't geolocate.
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const zipRaw = typeof cf.postalCode === 'string' ? cf.postalCode : '';
  // `regionCode` is the USPS 2-letter abbreviation ("WI"); `region` is the
  // full state name ("Wisconsin"). The client matches against the code
  // form, so prefer regionCode and fall back to "" rather than mixing in
  // the long form (which would never match the coverage allowlist).
  const stateRaw = typeof cf.regionCode === 'string' ? cf.regionCode : '';
  const latRaw = typeof cf.latitude === 'string' ? cf.latitude : '';
  const lonRaw = typeof cf.longitude === 'string' ? cf.longitude : '';

  const lat = Number.parseFloat(latRaw);
  const lon = Number.parseFloat(lonRaw);

  const body = JSON.stringify({
    zip: zipRaw,
    state: stateRaw,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  });

  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': GEO_CACHE_CONTROL,
  });
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return new Response(body, { headers });
}

function buildObjectHeaders(object: R2Object, cacheControl: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', cacheControl);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  // R2 payloads are JSON consumed by the client's fetch path; a browser
  // can still evaluate the response text if tricked, so apply the full
  // header set. CSP stays Report-Only until the flip criteria in
  // CSP_POLICY's docblock are met.
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return headers;
}

function notFound(body = 'Not found'): Response {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return new Response(body, { status: 404, headers });
}

function methodNotAllowed(allow = 'GET, HEAD'): Response {
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    allow,
  });
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return new Response('Method not allowed', { status: 405, headers });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * JSON 503 for a transient R2 failure (bucket.get/list threw). Cache-Control:
 * no-store so neither the browser nor Cloudflare's edge cache a failure
 * response under the endpoint's normal SWR policy, and Retry-After: 5 gives
 * well-behaved clients (and this repo's own fetchWithRetry backoff — 250ms/
 * 1000ms/2000ms, well under 5s) a concrete signal. Replaces Cloudflare's raw
 * "Error 1101" page, which carries none of the security headers below and
 * no machine-readable shape.
 */
function serviceUnavailable(message = 'Service temporarily unavailable'): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': '5',
  });
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return new Response(JSON.stringify({ error: message }), { status: 503, headers });
}

/**
 * JSON 500 for a code-level contract violation (e.g. R2 returning
 * truncated=true without a cursor — see listNewestHistoryEntries). Distinct
 * from serviceUnavailable(): this is a bug, not a transient upstream
 * failure, so no Retry-After — retrying immediately won't help.
 */
function internalError(message = 'Internal error'): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  applyBaselineSecurityHeaders(headers);
  applyCspReportOnly(headers);
  return new Response(JSON.stringify({ error: message }), { status: 500, headers });
}

/**
 * Maximum accepted body size for a CSP violation report. 16 KB is well above
 * any realistic report payload (typical reports are sub-2 KB) while keeping
 * the Worker immune to junk-POST amplification against the `report-uri`. A
 * hostile client that can't authenticate shouldn't be able to make us do
 * meaningful work per request.
 */
const CSP_REPORT_MAX_BYTES = 16 * 1024;

/**
 * Structured fields pulled out of a best-effort CSP report parse. All optional
 * because browsers differ on both envelope shape (`application/csp-report`
 * legacy vs `application/reports+json` modern) and which sub-fields they
 * populate. See handleCspReport() for the parse-and-log contract.
 */
interface CspReportFields {
  blocked_uri?: string;
  violated_directive?: string;
  source_file?: string;
  line_number?: number;
  script_sample?: string;
  disposition?: string;
}

/** Max chars retained for `script-sample` to keep log lines bounded. */
const CSP_SAMPLE_MAX_CHARS = 200;

function truncateSample(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > CSP_SAMPLE_MAX_CHARS ? value.slice(0, CSP_SAMPLE_MAX_CHARS) + '…' : value;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Extract the reporter-friendly subset of fields from whatever envelope the
 * browser sent. Legacy shape (`application/csp-report`):
 *   { "csp-report": { "blocked-uri": ..., "violated-directive": ..., ... } }
 * Modern Reporting API (`application/reports+json`) is a JSON array:
 *   [{ "type": "csp-violation", "body": { "blockedURL": ..., ... } }, ...]
 *
 * We accept both and return the first recognisable violation. On any
 * malformed input we return an empty object and let the caller log the raw
 * text — the contract is "best-effort, never crash".
 */
function extractCspFields(parsed: unknown): CspReportFields {
  // Legacy shape: { "csp-report": {...} }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const legacy = (parsed as Record<string, unknown>)['csp-report'];
    if (legacy && typeof legacy === 'object') {
      const r = legacy as Record<string, unknown>;
      return {
        blocked_uri: readString(r, 'blocked-uri') ?? readString(r, 'blockedURI'),
        violated_directive:
          readString(r, 'violated-directive') ?? readString(r, 'effective-directive'),
        source_file: readString(r, 'source-file'),
        line_number: readNumber(r, 'line-number'),
        script_sample: truncateSample(r['script-sample']),
        disposition: readString(r, 'disposition'),
      };
    }
  }
  // Modern Reporting API: array of { type, body }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const body = (entry as Record<string, unknown>).body;
      if (!body || typeof body !== 'object') continue;
      const r = body as Record<string, unknown>;
      return {
        blocked_uri: readString(r, 'blockedURL') ?? readString(r, 'blocked-uri'),
        violated_directive:
          readString(r, 'effectiveDirective') ?? readString(r, 'violatedDirective'),
        source_file: readString(r, 'sourceFile') ?? readString(r, 'source-file'),
        line_number: readNumber(r, 'lineNumber'),
        script_sample: truncateSample(r.sample ?? r['script-sample']),
        disposition: readString(r, 'disposition'),
      };
    }
  }
  return {};
}

/**
 * POST /csp-report — same-origin collector for CSP (Report-Only) violations.
 *
 * Contract:
 *   - Non-POST → 405 with `allow: POST`.
 *   - Body > 16 KB → 413 (defense against amplification abuse).
 *   - Accept both `application/csp-report` (legacy) and
 *     `application/reports+json` (modern Reporting API) envelopes; parse
 *     best-effort and log structured fields via console.warn.
 *   - Malformed JSON still returns 204 — reports are advisory, not critical,
 *     and crashing the Worker on hostile input would be worse than losing one
 *     sample. We log the raw (truncated) payload for forensics.
 *   - No persistence. No external reporting service. Logs land in CF
 *     workers.dev tail / Logpush and are reviewed manually per Open
 *     Decision #9's flip criteria.
 *
 * Exported for tests.
 */
export async function handleCspReport(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }

  // Reject oversize bodies up-front when the client advertises their size;
  // a dishonest Content-Length still gets caught after we read, below.
  const declaredLen = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen > CSP_REPORT_MAX_BYTES) {
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
    applyBaselineSecurityHeaders(headers);
    return new Response('Payload too large', { status: 413, headers });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    // Body read failed (client abort, malformed framing). Treat as advisory
    // loss and respond 204 so we don't block the browser on our bug.
    const headers = new Headers();
    applyBaselineSecurityHeaders(headers);
    return new Response(null, { status: 204, headers });
  }

  if (raw.length > CSP_REPORT_MAX_BYTES) {
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
    applyBaselineSecurityHeaders(headers);
    return new Response('Payload too large', { status: 413, headers });
  }

  let parsed: unknown;
  let parseOk = true;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    parseOk = false;
  }

  const fields = parseOk ? extractCspFields(parsed) : {};

  // Structured log line. console.warn lands in Workers tail output; the
  // reviewer greps for "csp_violation" to count distinct violation types
  // per day. Intentionally one line of JSON for easy ingestion.
  if (parseOk) {
    console.warn(
      JSON.stringify({
        event: 'csp_violation',
        blocked_uri: fields.blocked_uri,
        violated_directive: fields.violated_directive,
        source_file: fields.source_file,
        line_number: fields.line_number,
        script_sample: fields.script_sample,
        disposition: fields.disposition,
      }),
    );
  } else {
    // Keep the diagnostic — a persistent parse failure could indicate a
    // browser envelope shape we don't recognise.
    console.error(
      JSON.stringify({
        event: 'csp_violation_parse_error',
        // Never dump more than the sample cap to keep log cost bounded.
        raw_sample: truncateSample(raw),
      }),
    );
  }

  const headers = new Headers();
  applyBaselineSecurityHeaders(headers);
  return new Response(null, { status: 204, headers });
}
