import { describe, it, expect } from 'vitest';
import worker, {
  listNewestHistoryEntries,
  parsePerStateCode,
  serveGeoSuggestion,
  type Env,
  type R2BucketListOnly,
} from './index';
import { LIVE_CACHE_CONTROL } from './constants';
// R2ListOptions / R2Object / R2Objects are declared globally by
// @cloudflare/workers-types. We import the namespace explicitly so this
// test file stays compilable even if Vitest's tsconfig resolution drifts
// away from the Worker's own tsconfig (which is where the globals are
// registered in this repo).
import type { R2ListOptions } from '@cloudflare/workers-types';

/**
 * Build a fake R2 bucket whose `list()` returns `keys` in page-sized chunks
 * (ascending lex order, matching real R2 behavior). Honors `prefix`,
 * `cursor`, and `startAfter` so we can verify the bounded-scan implementation
 * seeks directly into the tail instead of scanning the whole bucket.
 *
 * Also counts list calls so tests can assert the scan-cost invariant
 * (one R2 class-A op per request in the common path, regardless of bucket
 * size). `calls` is the list-call counter; `lastOptions` captures the most
 * recent options passed to `list` for argument-shape assertions.
 */
interface FakeBucket extends R2BucketListOnly {
  calls: number;
  lastOptions: R2ListOptions | undefined;
}

function fakeBucket(keys: string[], pageSize = 1000): FakeBucket {
  const sorted = [...keys].sort();
  const bucket: FakeBucket = {
    calls: 0,
    lastOptions: undefined,
    async list(options) {
      bucket.calls += 1;
      bucket.lastOptions = options;
      const prefix = options?.prefix ?? '';
      const cursor = options?.cursor;
      const startAfter = options?.startAfter;
      // R2 semantics: cursor resumes an existing iteration; startAfter is
      // only honored when cursor is absent. If both appear the real service
      // errors, so we mirror that by preferring cursor (and our prod code
      // never sends both).
      let startIdx: number;
      if (cursor) {
        startIdx = sorted.findIndex((k) => k === cursor) + 1;
      } else if (startAfter) {
        // startAfter is exclusive: return keys strictly greater than it.
        startIdx = sorted.findIndex((k) => k > startAfter);
        if (startIdx === -1) startIdx = sorted.length;
      } else {
        startIdx = 0;
      }
      const filtered = sorted.slice(startIdx).filter((k) => k.startsWith(prefix));
      const page = filtered.slice(0, pageSize);
      const truncated = filtered.length > pageSize;
      const lastKey = page[page.length - 1];
      const objects = page.map((key) => ({ key }) as R2Object);
      if (truncated) {
        return {
          objects,
          truncated: true,
          cursor: lastKey,
          delimitedPrefixes: [],
        } as R2Objects;
      }
      return {
        objects,
        truncated: false,
        delimitedPrefixes: [],
      } as R2Objects;
    },
  };
  return bucket;
}

/** Generate a sorted sequence of N history keys at 30s cadence. */
function historyKeys(count: number, startIso = '2026-04-17T00:00:00Z'): string[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start + i * 30_000);
    const ts =
      d.getUTCFullYear().toString().padStart(4, '0') +
      (d.getUTCMonth() + 1).toString().padStart(2, '0') +
      d.getUTCDate().toString().padStart(2, '0') +
      'T' +
      d.getUTCHours().toString().padStart(2, '0') +
      d.getUTCMinutes().toString().padStart(2, '0') +
      d.getUTCSeconds().toString().padStart(2, '0') +
      'Z';
    return `history/${ts}.json`;
  });
}

/**
 * Anchor time used by most tests — matches the fixed start used by
 * `historyKeys()` so the bounded-window scan always covers the synthetic
 * bucket. Individual tests pass their own `now` when they need to probe
 * edge cases (clock skew, gaps, scaling).
 */
const DEFAULT_TEST_START = '2026-04-17T00:00:00Z';

/** `now` placed at `startIso + (count-1)*30s` — the timestamp of the last key
 *  in a `historyKeys(count)` series, i.e. the caller's "current moment". */
function nowAfterKeys(count: number, startIso = DEFAULT_TEST_START): Date {
  return new Date(new Date(startIso).getTime() + (count - 1) * 30_000);
}

describe('listNewestHistoryEntries', () => {
  it('returns all entries newest-first when total count is below limit', async () => {
    const keys = historyKeys(10);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60, nowAfterKeys(10));
    expect(result).toHaveLength(10);
    // First element should be the newest (last-generated) key.
    expect(result[0].ts).toBe('20260417T000430Z');
    // Last element should be the oldest.
    expect(result[result.length - 1].ts).toBe('20260417T000000Z');
  });

  it('returns the NEWEST N entries when total count exceeds limit (core bug fix)', async () => {
    // Regression guard: a naive list({limit: N}) would return the OLDEST N
    // keys because R2 list is lex-ascending. This verifies we return newest-
    // first regardless of bucket depth.
    const keys = historyKeys(500);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60, nowAfterKeys(500));
    expect(result).toHaveLength(60);
    // Newest entry is index 499 → 499*30s after start = 04:09:30Z.
    expect(result[0].ts).toBe('20260417T040930Z');
    // 60th-newest is index 440 → 440*30s = 03:40:00Z.
    expect(result[59].ts).toBe('20260417T034000Z');
  });

  it('bounds the scan to one R2 list call regardless of bucket size (scaling invariant)', async () => {
    // 30 days of keys = 86,400 entries. The old implementation needed 87
    // list calls (class-A ops) per cache miss. The bounded-window scan
    // should seek directly to the tail via `startAfter` and serve the
    // request with a single list call.
    const keys = historyKeys(86_400);
    const bucket = fakeBucket(keys);
    const result = await listNewestHistoryEntries(bucket, 60, nowAfterKeys(86_400));
    expect(bucket.calls).toBe(1);
    expect(result).toHaveLength(60);
    // Newest entry is the last-generated key at index 86_399.
    const expectedMs = new Date(DEFAULT_TEST_START).getTime() + 86_399 * 30_000;
    const expectedDate = new Date(expectedMs);
    const p = (n: number, w = 2) => n.toString().padStart(w, '0');
    const expectedTs =
      p(expectedDate.getUTCFullYear(), 4) +
      p(expectedDate.getUTCMonth() + 1) +
      p(expectedDate.getUTCDate()) +
      'T' +
      p(expectedDate.getUTCHours()) +
      p(expectedDate.getUTCMinutes()) +
      p(expectedDate.getUTCSeconds()) +
      'Z';
    expect(result[0].ts).toBe(expectedTs);
  });

  it('sends startAfter computed as now − window with the exact ingest key format', async () => {
    // Format-drift tripwire. The Go ingest writes `history/YYYYMMDDTHHMMSSZ.json`
    // (see seestorm-ingest/internal/publisher/r2.go). If the Worker's
    // formatter drifts from that format — missing Z, wrong digit padding,
    // added fractional seconds — `startAfter` seeks to the wrong position
    // and `/v1/history` silently returns empty. Assert the literal value
    // for a fixed `now` and limit so the test fails loudly on any drift.
    const keys = historyKeys(100);
    const bucket = fakeBucket(keys);
    const fixedNow = new Date('2026-04-17T05:00:00Z');
    // window = max(60*30*1.5, 15*60) = max(2700, 900) = 2700s = 45 min
    // windowStart = 05:00:00Z − 45 min = 04:15:00Z
    await listNewestHistoryEntries(bucket, 60, fixedNow);
    expect(bucket.lastOptions?.prefix).toBe('history/');
    expect(bucket.lastOptions?.startAfter).toBe('history/20260417T041500Z');
    expect(bucket.lastOptions?.cursor).toBeUndefined();
  });

  it('honors the 15-minute minimum window floor when limit is small', async () => {
    // limit=1 would otherwise produce a 45-second window — narrower than a
    // single ingest gap. The floor ensures we always scan at least 15 min.
    const bucket = fakeBucket([]);
    const fixedNow = new Date('2026-04-17T05:00:00Z');
    await listNewestHistoryEntries(bucket, 1, fixedNow);
    // 05:00:00Z − 15 min = 04:45:00Z
    expect(bucket.lastOptions?.startAfter).toBe('history/20260417T044500Z');
  });

  it('follows the cursor across multiple pages when the window spans more than one page', async () => {
    // Regression guard for the cursor-follow branch. With pageSize=200 and
    // a limit large enough that the window (limit*30s*1.5 → keys) overruns
    // one page, we must keep paging and still return the newest `limit`.
    // This also exercises the option-spread that swaps startAfter for cursor
    // on page 2+.
    const keys = historyKeys(400);
    const bucket = fakeBucket(keys, 200);
    const result = await listNewestHistoryEntries(bucket, 200, nowAfterKeys(400));
    expect(result).toHaveLength(200);
    expect(bucket.calls).toBeGreaterThanOrEqual(2);
    // Newest should be the final generated key, index 399 → start + 399*30s.
    const expectedMs = new Date(DEFAULT_TEST_START).getTime() + 399 * 30_000;
    const d = new Date(expectedMs);
    const p = (n: number, w = 2) => n.toString().padStart(w, '0');
    const expectedTs =
      p(d.getUTCFullYear(), 4) +
      p(d.getUTCMonth() + 1) +
      p(d.getUTCDate()) +
      'T' +
      p(d.getUTCHours()) +
      p(d.getUTCMinutes()) +
      p(d.getUTCSeconds()) +
      'Z';
    expect(result[0].ts).toBe(expectedTs);
  });

  it('throws if R2 returns truncated=true without a cursor (contract violation)', async () => {
    // Without this defense the loop would re-send startAfter and spin on
    // the same page forever. We fail loudly so CF analytics catches it
    // instead of burning R2 class-A ops silently.
    // R2Objects is a discriminated union: truncated=true requires a
    // cursor at the type level. To simulate a runtime contract violation
    // we cast through `unknown` — the whole point of this test is the
    // bucket returning a shape the types say shouldn't exist.
    const brokenBucket: R2BucketListOnly = {
      async list() {
        return {
          objects: [{ key: 'history/20260417T000000Z.json' } as R2Object],
          truncated: true,
          // cursor intentionally omitted — simulates R2 bug.
          delimitedPrefixes: [],
        } as unknown as R2Objects;
      },
    };
    await expect(
      listNewestHistoryEntries(brokenBucket, 60, new Date('2026-04-17T00:10:00Z')),
    ).rejects.toThrow(/truncated=true without a cursor/);
  });

  it('throws if the page budget is exceeded (defense against mis-sized window)', async () => {
    // If the window is pathologically large (future raise of HISTORY_MAX_LIMIT
    // combined with tiny pageSize), we cap pages rather than burning R2 ops
    // unbounded. Force this by making every page tiny AND truncated.
    const pageSize = 10;
    const keys = historyKeys(1000);
    const bucket = fakeBucket(keys, pageSize);
    await expect(listNewestHistoryEntries(bucket, 1000, nowAfterKeys(1000))).rejects.toThrow(
      /exceeded \d+ pages/,
    );
  });

  it('tolerates gaps in the ingest stream', async () => {
    // Simulate ingest briefly losing a few polls: first 60 keys, a 5-slot
    // gap, then another 60. The tail should be the newest 60 (post-gap),
    // unaffected by the missing slots.
    const first = historyKeys(60);
    const secondStart = new Date(new Date(DEFAULT_TEST_START).getTime() + (60 + 5) * 30_000);
    const second = historyKeys(60, secondStart.toISOString());
    const keys = [...first, ...second];
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60, nowAfterKeys(125));
    expect(result).toHaveLength(60);
    // Newest entry is the last of `second` = secondStart + 59*30s.
    const expectedNewestMs = secondStart.getTime() + 59 * 30_000;
    const d = new Date(expectedNewestMs);
    const p = (n: number, w = 2) => n.toString().padStart(w, '0');
    const expectedTs =
      p(d.getUTCFullYear(), 4) +
      p(d.getUTCMonth() + 1) +
      p(d.getUTCDate()) +
      'T' +
      p(d.getUTCHours()) +
      p(d.getUTCMinutes()) +
      p(d.getUTCSeconds()) +
      'Z';
    expect(result[0].ts).toBe(expectedTs);
  });

  it('returns the full tail when now drifts slightly ahead of the latest key (clock skew)', async () => {
    // Ingest stopped 10 s ago but Worker clock is "now". The window should
    // still cover the existing keys — we test that the 1.5x safety
    // multiplier plus the min-window floor absorb realistic skew.
    const keys = historyKeys(100);
    const driftedNow = new Date(nowAfterKeys(100).getTime() + 10_000);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60, driftedNow);
    expect(result).toHaveLength(60);
    // Newest returned should still be the last ingest key.
    expect(result[0].ts).toBe('20260417T004930Z');
  });

  it('skips malformed keys without crashing', async () => {
    // parseHistoryKey is a lightweight shape guard — it checks digit grouping
    // but not field ranges (e.g. "999999Z" passes). That's acceptable since
    // ingest owns the key format; we only need the parser to reject shapes
    // that would break `generated_at` rendering.
    const keys = [
      ...historyKeys(5),
      'history/not-a-timestamp.json',
      'history/',
      'history/2026041T000000Z.json', // wrong digit count
    ];
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60, nowAfterKeys(5));
    expect(result).toHaveLength(5);
  });

  it('returns an empty array for an empty bucket', async () => {
    const result = await listNewestHistoryEntries(fakeBucket([]), 60);
    expect(result).toEqual([]);
  });

  it('returns an empty array for a zero or negative limit', async () => {
    const keys = historyKeys(100);
    expect(await listNewestHistoryEntries(fakeBucket(keys), 0, nowAfterKeys(100))).toEqual([]);
    expect(await listNewestHistoryEntries(fakeBucket(keys), -1, nowAfterKeys(100))).toEqual([]);
  });

  it('maps ts to an ISO-ish generated_at field', async () => {
    const keys = historyKeys(1);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60, nowAfterKeys(1));
    expect(result[0]).toEqual({
      ts: '20260417T000000Z',
      generated_at: '2026-04-17T00:00:00Z',
    });
  });
});

// Per-state route validation. The worker MUST reject anything that doesn't
// match the exact `{STATE}.json` shape — accepting arbitrary path segments
// here would let clients ask for arbitrary R2 objects under our prefix.
describe('parsePerStateCode', () => {
  const valid: Array<[string, string]> = [
    ['/v1/active-events/WI.json', 'WI'],
    ['/v1/active-events/IL.json', 'IL'],
    ['/v1/active-events/MN.json', 'MN'],
    ['/v1/active-events/NY.json', 'NY'],
  ];
  for (const [path, state] of valid) {
    it(`accepts ${path}`, () => {
      expect(parsePerStateCode(path)).toBe(state);
    });
  }

  const invalid = [
    // Wrong prefix
    '/v1/history/WI.json',
    '/active-events/WI.json',
    // Lowercase / mixed case — must be uppercase USPS
    '/v1/active-events/wi.json',
    '/v1/active-events/Wi.json',
    // Wrong length
    '/v1/active-events/WIS.json',
    '/v1/active-events/W.json',
    '/v1/active-events/.json',
    // Missing extension
    '/v1/active-events/WI',
    '/v1/active-events/WI.JSON',
    // Path traversal / nested segments
    '/v1/active-events/WI/IL.json',
    '/v1/active-events/../active-events.json',
    '/v1/active-events//IL.json',
    // Query soup glued onto the path
    '/v1/active-events/WI.json?foo=bar', // pathname only — querystring lives elsewhere; covered for safety
    // Non-ASCII / suspicious characters
    '/v1/active-events/W%I.json',
    '/v1/active-events/WI .json',
    '/v1/active-events/W I.json',
  ];
  for (const path of invalid) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(parsePerStateCode(path)).toBeNull();
    });
  }
});

/**
 * Build a mock Request that carries a synthetic `request.cf` payload. The
 * Workers runtime's `IncomingRequestCfProperties` is read off the wire by
 * Cloudflare and isn't otherwise constructible — we cast through `unknown`
 * to attach exactly the fields `serveGeoSuggestion` consumes.
 */
function requestWithCf(cf: Record<string, unknown> | undefined): Request {
  const req = new Request('https://seestorm.example/v1/geo');
  // `cf` is read-only on real Workers requests; tests need to attach a
  // controlled payload, so we cast through unknown and define the property
  // directly. This is exactly the seam the production code reads through.
  Object.defineProperty(req, 'cf', { value: cf, configurable: true });
  return req;
}

describe('serveGeoSuggestion', () => {
  it('returns the USPS code from cf.regionCode (NOT the long-form region name)', async () => {
    // Regression guard for the bug this task fixes: cf.region is the full
    // state name ("Wisconsin") which never matches the client's USPS-keyed
    // coverage map. cf.regionCode is the 2-letter form the client expects.
    const response = serveGeoSuggestion(
      requestWithCf({
        postalCode: '53703',
        regionCode: 'WI',
        region: 'Wisconsin',
        latitude: '43.0747',
        longitude: '-89.3838',
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      zip: '53703',
      state: 'WI',
      lat: 43.0747,
      lon: -89.3838,
    });
  });

  it('returns empty state when cf.regionCode is missing (corporate proxy / unknown IP)', async () => {
    // CF can't always geolocate (corporate proxies, recently-changed
    // allocations) — the response shape must stay stable so the client's
    // schema guard doesn't reject the payload, with `state: ""` as the
    // signal that no inference was possible.
    const response = serveGeoSuggestion(
      requestWithCf({
        postalCode: '',
        latitude: '',
        longitude: '',
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      zip: '',
      state: '',
      lat: null,
      lon: null,
    });
  });

  it('returns null lat/lon when the coordinates are non-numeric or absent', async () => {
    const response = serveGeoSuggestion(
      requestWithCf({
        regionCode: 'IL',
        // latitude/longitude omitted entirely.
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe('IL');
    expect(body.lat).toBeNull();
    expect(body.lon).toBeNull();
  });

  it('handles a missing cf object entirely without throwing', async () => {
    // The Workers runtime always sets `request.cf`, but defensive coding
    // here keeps a future framework-level change (or a test fixture that
    // forgets to populate it) from 500-ing the endpoint.
    const response = serveGeoSuggestion(requestWithCf(undefined));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ zip: '', state: '', lat: null, lon: null });
  });

  it('ignores non-string regionCode (defends against runtime drift)', async () => {
    const response = serveGeoSuggestion(
      requestWithCf({
        regionCode: 42, // wrong type — production CF would never send this
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe('');
  });
});

// ---------------------------------------------------------------------------
// /v1/active-events.json — ETag / 304 / Cache-Control contract
// ---------------------------------------------------------------------------
//
// Tests the live-snapshot path end-to-end via `worker.fetch` with a fake
// R2Bucket. Covers the four conditions called out in Open Decisions #4 for
// Tier 1 #4c:
//   1. Happy path — 200 + ETag + SWR Cache-Control
//   2. Matching If-None-Match — 304 with no body, headers preserved
//   3. Stale If-None-Match — 200 with new body + new ETag
//   4. Malformed If-None-Match — 200 body served (no crash)
//
// R2's `get(key, { onlyIf: { etagDoesNotMatch } })` is the conditional
// primitive the Worker uses. When the etag matches, R2 returns a plain
// `R2Object` (no `body` prop); otherwise it returns an `R2ObjectBody`.
// The fake below mirrors that distinction faithfully.

interface FakeR2Object {
  key: string;
  httpEtag: string;
  body?: ReadableStream<Uint8Array>;
  writeHttpMetadata(headers: Headers): void;
}

interface FakeSnapshotBucket {
  get(
    key: string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<FakeR2Object | null>;
}

/**
 * Build a fake SNAPSHOTS bucket that serves a single object under `key`
 * with the given `body` and a derived ETag. ETag shape mirrors R2's real
 * quoted form so the conditional comparison has realistic bytes to match
 * against — `etag: "abc123"` (with quotes, per HTTP spec).
 */
function fakeSnapshotBucket(key: string, body: string, etag: string): FakeSnapshotBucket {
  const quotedEtag = etag.startsWith('"') ? etag : `"${etag}"`;
  return {
    async get(requestedKey, options) {
      if (requestedKey !== key) return null;
      const ifMatchesExisting = options?.onlyIf?.etagDoesNotMatch === quotedEtag;
      const base: FakeR2Object = {
        key,
        httpEtag: quotedEtag,
        writeHttpMetadata(headers: Headers) {
          headers.set('content-type', 'application/json; charset=utf-8');
        },
      };
      if (ifMatchesExisting) {
        // Conditional satisfied → R2 returns an R2Object without a body,
        // which the Worker translates to a 304 Not Modified.
        return base;
      }
      return {
        ...base,
        body: new Response(body).body ?? new ReadableStream(),
      };
    },
  };
}

/** Build a bare `Env` adequate for /v1/* tests — only SNAPSHOTS is read. */
function envWithSnapshots(snapshots: FakeSnapshotBucket): Env {
  return {
    // Worker types on R2Bucket require the full surface, but the live-snapshot
    // path only exercises `get`. Cast through unknown to satisfy the compiler
    // without pulling in the rest of the R2Bucket API for a tiny test fake.
    SNAPSHOTS: snapshots as unknown as R2Bucket,
    // ASSETS is never invoked for /v1/* requests; stub with a throwing fetcher
    // so a misrouted test fails loudly instead of silently hitting a static
    // asset handler.
    ASSETS: {
      fetch: () => {
        throw new Error('ASSETS.fetch should not be called for /v1/* tests');
      },
    } as unknown as Fetcher,
  };
}

describe('GET /v1/active-events.json — ETag / 304 / SWR contract', () => {
  const KEY = 'active-events.json';
  const BODY = JSON.stringify({ features: [], generated_at_ms: 1_700_000_000_000 });
  const ETAG = '"snapshot-v1-abc"';

  it('returns 200 with ETag + SWR Cache-Control on a cold request (no If-None-Match)', async () => {
    const env = envWithSnapshots(fakeSnapshotBucket(KEY, BODY, ETAG));
    const res = await worker.fetch(
      new Request('https://seestorm.example/v1/active-events.json'),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(ETAG);
    // Audit constant — do not hardcode the literal string here so drift in
    // constants.ts is caught by the constants tests, not by every route test.
    expect(res.headers.get('cache-control')).toBe(LIVE_CACHE_CONTROL);
    // SWR must be present; regressing to plain `max-age=30` would remove the
    // thundering-herd mitigation the audit calls for.
    expect(res.headers.get('cache-control')).toMatch(/stale-while-revalidate=30/);
    const text = await res.text();
    expect(text).toBe(BODY);
  });

  it('returns 304 with no body when If-None-Match matches the stored ETag', async () => {
    const env = envWithSnapshots(fakeSnapshotBucket(KEY, BODY, ETAG));
    const res = await worker.fetch(
      new Request('https://seestorm.example/v1/active-events.json', {
        headers: { 'If-None-Match': ETAG },
      }),
      env,
    );
    expect(res.status).toBe(304);
    // 304 MUST preserve ETag + Cache-Control so CF edge revalidation semantics
    // stay correct on the downstream browser. Stripping either would either
    // force a full re-GET or break intermediate caches.
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe(LIVE_CACHE_CONTROL);
    // No body on a 304 — browsers treat any payload here as protocol error.
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns 200 with fresh body + new ETag when If-None-Match is stale', async () => {
    const env = envWithSnapshots(fakeSnapshotBucket(KEY, BODY, ETAG));
    const res = await worker.fetch(
      new Request('https://seestorm.example/v1/active-events.json', {
        headers: { 'If-None-Match': '"snapshot-from-yesterday"' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(ETAG);
    const text = await res.text();
    expect(text).toBe(BODY);
  });

  it('serves 200 body on malformed If-None-Match instead of crashing', async () => {
    const env = envWithSnapshots(fakeSnapshotBucket(KEY, BODY, ETAG));
    // Not quoted, not a valid opaque tag — an old or buggy client might send
    // this shape. The Worker should treat it as a non-match and serve the
    // current body rather than erroring the request.
    const res = await worker.fetch(
      new Request('https://seestorm.example/v1/active-events.json', {
        headers: { 'If-None-Match': 'not a real etag' },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(ETAG);
    const text = await res.text();
    expect(text).toBe(BODY);
  });
});
