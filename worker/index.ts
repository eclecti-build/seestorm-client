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

export interface Env {
  /** Binding to the `seestorm-data` R2 bucket. Read-only from this Worker. */
  SNAPSHOTS: R2Bucket;
  /** Binding to the bundled Next.js static export (./out). */
  ASSETS: Fetcher;
}

/**
 * Edge cache for the live endpoint. Ingest rewrites the snapshot every 30s,
 * so a 10s TTL guaranteed a cache miss on every ~3rd client poll and hammered
 * R2. Align the TTL to the producer cadence so at most one R2 GET per edge
 * PoP per 30s window, regardless of how many users are watching.
 */
const LIVE_CACHE_CONTROL = 'public, max-age=30, s-maxage=30';

/** Historical snapshots are immutable once written — cache for a year. */
const HISTORY_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * History list metadata. The list only changes when a new snapshot is written
 * (every 30s), and listing is an R2 class-A op that pages the full history/
 * prefix — by far the most expensive request we serve. A 60s TTL roughly
 * halves that load with at most one extra snapshot's worth of staleness.
 */
const LIST_CACHE_CONTROL = 'public, max-age=60, s-maxage=60';

/**
 * /v1/geo cache. The CF edge derives geo from the *requesting IP*, so the
 * answer is per-IP. We cache modestly at the edge (5min) with SWR so a flood
 * of clients in the same metro share a hit, and stale-while-revalidate keeps
 * latency low when the cache age rolls over.
 */
const GEO_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';

/** Compact RFC3339-like timestamp: 20060102T150405Z (matches ingest's key format). */
const TIMESTAMP_RE = /^\d{8}T\d{6}Z$/;

/**
 * USPS 2-letter state code, uppercase only. The per-state R2 keys use this
 * exact shape (`active-events/{STATE}.json`), so any tightening here must
 * stay in lockstep with the ingest-side `nws.IsValidStateCode` allowlist.
 *
 * Regex-only is intentional: full FIPS-membership validation lives at the
 * write side. The Worker accepts any well-formed token and returns 404 if
 * R2 has no matching object — which happens naturally for states ingest
 * isn't configured for, with no client-side coupling to the deployed area
 * list.
 */
const STATE_CODE_RE = /^[A-Z]{2}$/;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/v1/')) {
      return handleApiRequest(request, url, env);
    }

    // Anything not under /v1/ is static Next.js content.
    return env.ASSETS.fetch(request);
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
  const stateCode = parsePerStateCode(url.pathname);
  if (stateCode !== null) {
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
  const ifNoneMatch = request.headers.get('if-none-match') ?? undefined;
  const object = await env.SNAPSHOTS.get(key, {
    onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
  });

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

  const snapshots = await listNewestHistoryEntries(env.SNAPSHOTS, limit);

  const body = JSON.stringify({
    snapshots,
    count: snapshots.length,
  });

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': LIST_CACHE_CONTROL,
    },
  });
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
 * The IP-derived ZIP is the *postal code at the IP geolocation endpoint*,
 * which is sometimes a regional code, not the user's actual home ZIP. The
 * client UI must label this as a "guess" rather than treating it as
 * authoritative — see LocationBanner for the manual-override path.
 */
function serveGeoSuggestion(request: Request): Response {
  // Cloudflare's typed `request.cf` is `IncomingRequestCfProperties`. Some
  // fields (postalCode, region) are documented as `string` but can be empty.
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const zipRaw = typeof cf.postalCode === 'string' ? cf.postalCode : '';
  const stateRaw = typeof cf.region === 'string' ? cf.region : '';
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

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': GEO_CACHE_CONTROL,
    },
  });
}

function buildObjectHeaders(object: R2Object, cacheControl: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', cacheControl);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  return headers;
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', {
    status: 405,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      allow: 'GET, HEAD',
    },
  });
}
