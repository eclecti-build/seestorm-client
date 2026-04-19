import { describe, it, expect } from 'vitest';
import {
  LIVE_CACHE_CONTROL,
  LIST_CACHE_CONTROL,
  HISTORY_CACHE_CONTROL,
  GEO_CACHE_CONTROL,
} from './constants';

// Pin the four Cache-Control strings to the audit contract verbatim
// (docs/SWARM_AUDIT_2026-04-18.md — "Constants — paste-ready"). These
// values are the surface a downstream operator would grep for when
// debugging a CF cache miss, so drift between this file and the audit
// doc is a first-class regression — fail loudly rather than let a
// whitespace change slip in.

describe('worker cache-control constants — audit contract', () => {
  it('LIVE carries SWR for thundering-herd mitigation at 30s TTL rollover', () => {
    expect(LIVE_CACHE_CONTROL).toBe('public, max-age=30, s-maxage=60, stale-while-revalidate=30');
  });

  it('LIST carries SWR for R2 class-A op amortization', () => {
    expect(LIST_CACHE_CONTROL).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=60');
  });

  it('HISTORY is one-year immutable (archived timestamps never change content)', () => {
    expect(HISTORY_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  it('GEO has browser max-age + edge s-maxage + SWR', () => {
    expect(GEO_CACHE_CONTROL).toBe('public, max-age=300, s-maxage=300, stale-while-revalidate=60');
  });
});
