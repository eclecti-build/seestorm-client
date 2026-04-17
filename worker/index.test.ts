import { describe, it, expect } from 'vitest';
import { listNewestHistoryEntries, type R2BucketListOnly } from './index';

/**
 * Build a fake R2 bucket whose `list()` returns `keys` in page-sized chunks
 * (ascending lex order, matching real R2 behavior). Lets us verify that the
 * paginated tail-buffer implementation returns the *newest* N entries rather
 * than the first N R2 hands back.
 */
function fakeBucket(keys: string[], pageSize = 1000): R2BucketListOnly {
  const sorted = [...keys].sort();
  return {
    async list(options) {
      const prefix = options?.prefix ?? '';
      const cursor = options?.cursor;
      const startIdx = cursor ? sorted.findIndex((k) => k === cursor) + 1 : 0;
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

describe('listNewestHistoryEntries', () => {
  it('returns all entries newest-first when total count is below limit', async () => {
    const keys = historyKeys(10);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60);
    expect(result).toHaveLength(10);
    // First element should be the newest (last-generated) key.
    expect(result[0].ts).toBe('20260417T000430Z');
    // Last element should be the oldest.
    expect(result[result.length - 1].ts).toBe('20260417T000000Z');
  });

  it('returns the NEWEST N entries when total count exceeds limit (core bug fix)', async () => {
    // Regression guard: the old implementation would slice the OLDEST N keys
    // because R2 list is lex-ascending. This test ensures we page to the end
    // and keep a rolling tail of the newest entries.
    const keys = historyKeys(500);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60);
    expect(result).toHaveLength(60);
    // Newest entry is index 499 → 499*30s after start = 04:09:30Z.
    expect(result[0].ts).toBe('20260417T040930Z');
    // 60th-newest is index 440 → 440*30s = 03:40:00Z.
    expect(result[59].ts).toBe('20260417T034000Z');
  });

  it('paginates correctly across multiple R2 list pages', async () => {
    // Two full pages + partial — forces the tail buffer to survive across
    // pagination boundaries, which is where the rolling-window logic matters.
    const keys = historyKeys(2500);
    const bucket = fakeBucket(keys, 1000);
    const result = await listNewestHistoryEntries(bucket, 60);
    expect(result).toHaveLength(60);
    // Newest = 2500th generated key, at start + 2499 * 30s.
    const expectedNewest = new Date(
      new Date('2026-04-17T00:00:00Z').getTime() + 2499 * 30_000,
    );
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const expectedTs =
      pad(expectedNewest.getUTCFullYear(), 4) +
      pad(expectedNewest.getUTCMonth() + 1) +
      pad(expectedNewest.getUTCDate()) +
      'T' +
      pad(expectedNewest.getUTCHours()) +
      pad(expectedNewest.getUTCMinutes()) +
      pad(expectedNewest.getUTCSeconds()) +
      'Z';
    expect(result[0].ts).toBe(expectedTs);
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
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60);
    expect(result).toHaveLength(5);
  });

  it('returns an empty array for an empty bucket', async () => {
    const result = await listNewestHistoryEntries(fakeBucket([]), 60);
    expect(result).toEqual([]);
  });

  it('returns an empty array for a zero or negative limit', async () => {
    const keys = historyKeys(100);
    expect(await listNewestHistoryEntries(fakeBucket(keys), 0)).toEqual([]);
    expect(await listNewestHistoryEntries(fakeBucket(keys), -1)).toEqual([]);
  });

  it('maps ts to an ISO-ish generated_at field', async () => {
    const keys = historyKeys(1);
    const result = await listNewestHistoryEntries(fakeBucket(keys), 60);
    expect(result[0]).toEqual({
      ts: '20260417T000000Z',
      generated_at: '2026-04-17T00:00:00Z',
    });
  });
});
