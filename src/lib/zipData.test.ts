// Regression guard for the shipped ZIP coverage table.
//
// These tests load the actual `public/data/zip-us.json` from disk and fail
// CI if it ever truncates back to a stub or drops covered states.
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

const DATA_PATH = resolve(__dirname, '../../public/data/zip-us.json');

function loadTable(): Record<string, ZipRecord> {
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as Record<string, unknown>;
  const out: Record<string, ZipRecord> = {};
  for (const [zip, record] of Object.entries(raw)) {
    if (!/^\d{5}$/.test(zip)) continue;
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

describe('zip-us.json coverage', () => {
  const table = loadTable();

  it('contains at least 30,000 ZIP entries (national coverage)', () => {
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(30000);
  });

  it('resolves 53704 (Madison, WI) — the ZIP from the original production bug report', () => {
    expect(table['53704']).toBeDefined();
    expect(table['53704'].state).toBe('WI');
  });

  const representatives: Array<[string, string, string]> = [
    ['55401', 'MN', 'Minneapolis'],
    ['53704', 'WI', 'Madison'],
    ['50309', 'IA', 'Des Moines'],
    ['60601', 'IL', 'Chicago'],
    ['46204', 'IN', 'Indianapolis'],
    ['48201', 'MI', 'Detroit'],
    ['44101', 'OH', 'Cleveland'],
    ['19103', 'PA', 'Philadelphia'],
    ['10001', 'NY', 'Manhattan'],
    ['90210', 'CA', 'Beverly Hills'],
    ['77002', 'TX', 'Houston'],
    ['33101', 'FL', 'Miami'],
    ['98101', 'WA', 'Seattle'],
    ['80202', 'CO', 'Denver'],
    ['30303', 'GA', 'Atlanta'],
  ];

  it.each(representatives)('resolves %s to %s (%s)', (zip, state) => {
    const record = table[zip];
    expect(record, `missing ${zip}`).toBeDefined();
    expect(record.state).toBe(state);
  });

  it('covers all 50 states + DC with at least 10 ZIPs each', () => {
    const countsByState = new Map<string, number>();
    for (const rec of Object.values(table)) {
      countsByState.set(rec.state, (countsByState.get(rec.state) ?? 0) + 1);
    }
    const states = [
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
    ];
    for (const state of states) {
      expect(countsByState.get(state) ?? 0, `state ${state}`).toBeGreaterThanOrEqual(10);
    }
  });
});
