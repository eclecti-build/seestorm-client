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
 * Public surface is versioned at `/v1/*` so we can evolve response formats
 * later without breaking clients.
 */

export interface Env {
  /** Binding to the `seestorm-data` R2 bucket. Read-only from this Worker. */
  SNAPSHOTS: R2Bucket;
  /** Binding to the bundled Next.js static export (./out). */
  ASSETS: Fetcher;
}

/**
 * Allowlist of snapshot object keys the public API will serve.
 * Anything the ingest service publishes that should be *internal* stays
 * off this list — only whitelisted keys are reachable from the public URL.
 */
const PUBLIC_SNAPSHOTS: ReadonlySet<string> = new Set(['active-events.json']);

/** Edge cache hint. Client polls every 10s so matching s-maxage keeps R2 cold. */
const CACHE_CONTROL = 'public, max-age=10, s-maxage=10';

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

  const objectKey = url.pathname.slice('/v1/'.length);

  if (!PUBLIC_SNAPSHOTS.has(objectKey)) {
    return notFound();
  }

  const ifNoneMatch = request.headers.get('if-none-match') ?? undefined;
  const object = await env.SNAPSHOTS.get(objectKey, {
    onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
  });

  if (object === null) {
    return notFound();
  }

  // R2 returns an R2ObjectBody on fetch, or a plain R2Object when the
  // conditional was satisfied (etag matched) — signal 304 to the client.
  if (!('body' in object)) {
    return new Response(null, {
      status: 304,
      headers: withStandardHeaders(new Headers(), object),
    });
  }

  const headers = withStandardHeaders(new Headers(), object);
  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}

function withStandardHeaders(headers: Headers, object: R2Object): Headers {
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', CACHE_CONTROL);
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
