// Regression guard for the shipped ZIP coverage table.
//
// On 2026-04-17, the Great Lakes rollout shipped with `public/data/zip-
// greatlakes.json` as a 31-ZIP stub, so every real-world ZIP (including
// Madison's 53704) hit the "not in our coverage area" branch in
// LocationBanner. These tests load the actual file and fail CI if it ever
// truncates back to a stub or drops one of the 9 target states (GL 8 + IA).
//
// The file is read from disk (not fetched) so this runs cleanly in Vitest's
// jsdom environment without needing to stand up a dev server.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

interface ZipRecord {
  lat: number;
  lon: number;
  state: string;
  county: string;
}

const DATA_PATH = resolve(__dirname, '../../public/data/zip-greatlakes.json');

function loadTable(): Record<string, ZipRecord> {
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Record<string, unknown>;
  const out: Record<string, ZipRecord> = {};
  for (const [zip, record] of Object.entries(raw)) {
    if (!/^\d{5}$/.test(zip)) continue; // skip _meta or other non-ZIP keys
    if (
      record &&
      typeof record === 'object' &&
      typeof (record as ZipRecord).lat === 'number' &&
      typeof (record as ZipRecord).lon === 'number' &&
      typeof (record as ZipRecord).state === 'string'
    ) {
      out[zip] = record as ZipRecord;
    }
  }
  return out;
}

describe('zip-greatlakes.json coverage', () => {
  const table = loadTable();

  // The original stub had 31 entries. Real coverage should be in the
  // thousands — if we regress below this threshold the data pipeline broke.
  it('contains at least 5,000 ZIP entries (not a stub)', () => {
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(5000);
  });

  // Explicit regression case from the bug report: Madison, WI 53704 must
  // resolve. This is the ZIP a real user reported as "not in coverage area."
  it('resolves 53704 (Madison, WI) — the ZIP from the production bug report', () => {
    expect(table['53704']).toBeDefined();
    expect(table['53704'].state).toBe('WI');
  });

  // One representative ZIP per target state, spanning the whole coverage
  // region. If any of these goes missing, LocationBanner will falsely
  // reject users in that state.
  const representatives: Array<[string, string, string]> = [
    ['55401', 'MN', 'Minneapolis'],
    ['53704', 'WI', 'Madison'],
    ['53703', 'WI', 'Madison (downtown)'],
    ['50309', 'IA', 'Des Moines'],
    ['60601', 'IL', 'Chicago'],
    ['46204', 'IN', 'Indianapolis'],
    ['48201', 'MI', 'Detroit'],
    ['44101', 'OH', 'Cleveland'],
    ['19103', 'PA', 'Philadelphia'],
    ['10001', 'NY', 'Manhattan'],
  ];

  it.each(representatives)('resolves %s to %s (%s)', (zip, state) => {
    const record = table[zip];
    expect(record, `missing ${zip}`).toBeDefined();
    expect(record.state).toBe(state);
  });

  // Every one of the 9 covered states must have *some* ZIPs — catches a
  // half-broken pipeline that quietly drops a state.
  it('covers all 9 target states with at least 100 ZIPs each', () => {
    const countsByState = new Map<string, number>();
    for (const rec of Object.values(table)) {
      countsByState.set(rec.state, (countsByState.get(rec.state) ?? 0) + 1);
    }
    for (const state of ['MN', 'WI', 'IA', 'IL', 'IN', 'MI', 'OH', 'PA', 'NY']) {
      expect(countsByState.get(state) ?? 0, `state ${state}`).toBeGreaterThanOrEqual(100);
    }
  });
});
