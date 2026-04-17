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

/** Short edge cache for the live endpoint — ingest rewrites every 30s. */
const LIVE_CACHE_CONTROL = 'public, max-age=10, s-maxage=10';

/** Historical snapshots are immutable once written — cache for a year. */
const HISTORY_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** History list metadata — short cache so new snapshots appear promptly. */
const LIST_CACHE_CONTROL = 'public, max-age=10, s-maxage=10';

/** Compact RFC3339-like timestamp: 20060102T150405Z (matches ingest's key format). */
const TIMESTAMP_RE = /^\d{8}T\d{6}Z$/;

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

  // /v1/active-events.json — the live overwritten snapshot.
  if (url.pathname === '/v1/active-events.json') {
    return serveObject(request, env, 'active-events.json', LIVE_CACHE_CONTROL);
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

/**
 * Return the newest `limit` history entries in descending chronological order.
 *
 * R2 only returns keys in ascending lexicographic order and has no native
 * "list from the end" option. Naively listing with `limit: N` returns the
 * OLDEST N keys, not the newest — which was a long-latent bug. We instead
 * page through the full history/ listing and keep a rolling tail of the last
 * `limit` entries.
 *
 * Cost: O(ceil(total_keys / R2_LIST_PAGE_SIZE)) list calls. At 30s ingest
 * cadence this grows by ~2,880 keys/day, so we should add an R2 lifecycle
 * rule to trim ancient history when the bucket gets large. Until then the
 * call is cheap and bounded.
 */
export async function listNewestHistoryEntries(
  bucket: R2BucketListOnly,
  limit: number,
): Promise<HistoryEntry[]> {
  if (limit <= 0) return [];

  const tail: HistoryEntry[] = [];
  let cursor: string | undefined;

  do {
    const page: R2Objects = await bucket.list({
      prefix: 'history/',
      limit: R2_LIST_PAGE_SIZE,
      cursor,
    });

    for (const object of page.objects) {
      const parsed = parseHistoryKey(object.key);
      if (parsed === null) continue;
      tail.push(parsed);
      if (tail.length > limit) tail.shift();
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return tail.reverse();
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
