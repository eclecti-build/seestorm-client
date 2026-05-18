import { describe, it, expect } from 'vitest';
import {
  LIVE_CACHE_CONTROL,
  LIST_CACHE_CONTROL,
  HISTORY_CACHE_CONTROL,
  GEO_CACHE_CONTROL,
} from './constants';

// Pin the four Cache-Control strings. These values are the surface a
// downstream operator would grep for when debugging a CF cache miss, and
// /v1/geo's privacy contract depends on staying non-storeable.

describe('worker cache-control constants', () => {
  it('LIVE carries SWR for thundering-herd mitigation at 30s TTL rollover', () => {
    expect(LIVE_CACHE_CONTROL).toBe('public, max-age=30, s-maxage=60, stale-while-revalidate=30');
  });

  it('LIST carries SWR for R2 class-A op amortization', () => {
    expect(LIST_CACHE_CONTROL).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=60');
  });

  it('HISTORY is one-year immutable (archived timestamps never change content)', () => {
    expect(HISTORY_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  it('GEO is private and non-storeable because it is IP-derived', () => {
    expect(GEO_CACHE_CONTROL).toBe('private, no-store');
  });
});
