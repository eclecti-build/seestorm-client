import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyGeoDefaultIfNeeded, fetchGeoSuggestion, DEFAULT_GEO_TIMEOUT_MS } from './geoDefault';
import { STATE_CENTERS } from './coverage';
import { getUserLocation, setUserLocation } from './userLocation';

/**
 * Build a `fetch`-compatible mock that returns the given JSON body with the
 * given status. Returning a Response-like object keeps the tests honest about
 * the .ok / .json contract `geoDefault` actually depends on.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOW_MS = 1_700_000_000_000;
const fixedNow = () => NOW_MS;

describe('fetchGeoSuggestion', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns a UserLocation with source=ip when CF returns a supported state', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '53703', state: 'WI', lat: 43.07, lon: -89.38 }));
    const result = await fetchGeoSuggestion({ fetchImpl, now: fixedNow });
    expect(result).toEqual({
      state: 'WI',
      lat: STATE_CENTERS.WI.lat,
      lon: STATE_CENTERS.WI.lon,
      source: 'ip',
      setAt: NOW_MS,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/v1/geo',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses STATE_CENTERS lat/lon, NOT the IP-derived coordinates', async () => {
    // The IP geolocator can put the user in the middle of a different state's
    // metro area. We anchor to the canonical state center so the map reads
    // sensibly at the state level — IP precision isn't trustworthy here.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '60601', state: 'IL', lat: 99.99, lon: -99.99 }));
    const result = await fetchGeoSuggestion({ fetchImpl, now: fixedNow });
    expect(result?.lat).toBe(STATE_CENTERS.IL.lat);
    expect(result?.lon).toBe(STATE_CENTERS.IL.lon);
  });

  it('uppercases the state before checking support', async () => {
    // CF should return uppercase but we defend against drift — the
    // membership check is case-sensitive, so a lowercase response would
    // otherwise silently fall through to "unsupported".
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '', state: 'wi', lat: null, lon: null }));
    const result = await fetchGeoSuggestion({ fetchImpl, now: fixedNow });
    expect(result?.state).toBe('WI');
  });

  it('returns null when the inferred state is not in the 8-state coverage', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '94102', state: 'CA', lat: 37.77, lon: -122.42 }));
    const result = await fetchGeoSuggestion({ fetchImpl, now: fixedNow });
    expect(result).toBeNull();
  });

  it('returns null when state is empty (CF could not infer)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '', state: '', lat: null, lon: null }));
    expect(await fetchGeoSuggestion({ fetchImpl, now: fixedNow })).toBeNull();
  });

  it('returns null on non-2xx response without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    expect(await fetchGeoSuggestion({ fetchImpl, now: fixedNow })).toBeNull();
  });

  it('returns null on network error without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network fail'));
    expect(await fetchGeoSuggestion({ fetchImpl, now: fixedNow })).toBeNull();
  });

  it('returns null on malformed JSON body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    expect(await fetchGeoSuggestion({ fetchImpl, now: fixedNow })).toBeNull();
  });

  it('returns null on payload with wrong shape (defends against schema drift)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: 123 /* should be string */ }));
    expect(await fetchGeoSuggestion({ fetchImpl, now: fixedNow })).toBeNull();
  });

  it('aborts and returns null when the request exceeds the timeout', async () => {
    // Resolve only after the abort fires — we should still get null promptly,
    // not block the whole first-paint waiting on a slow edge.
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const result = await fetchGeoSuggestion({ fetchImpl, now: fixedNow, timeoutMs: 5 });
    expect(result).toBeNull();
  });

  it('exports a sane default timeout matching the task spec (~1.5s)', () => {
    expect(DEFAULT_GEO_TIMEOUT_MS).toBe(1500);
  });
});

describe('applyGeoDefaultIfNeeded', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists the inferred default and reports kind=applied on first visit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '53703', state: 'WI', lat: 43.07, lon: -89.38 }));
    const outcome = await applyGeoDefaultIfNeeded({ fetchImpl, now: fixedNow });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.location.state).toBe('WI');
      expect(outcome.location.source).toBe('ip');
    }
    // Persisted to localStorage so the next visit short-circuits.
    const stored = getUserLocation();
    expect(stored?.state).toBe('WI');
    expect(stored?.source).toBe('ip');
  });

  it('short-circuits without fetching when a saved location already exists', async () => {
    setUserLocation({
      state: 'IL',
      lat: 40,
      lon: -89,
      source: 'manual',
      setAt: 1,
    });
    const fetchImpl = vi.fn();
    const outcome = await applyGeoDefaultIfNeeded({ fetchImpl, now: fixedNow });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('saved');
    if (outcome.kind === 'saved') {
      expect(outcome.location.source).toBe('manual');
    }
  });

  it('reports kind=none and persists nothing when the inferred state is unsupported', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ zip: '94102', state: 'CA', lat: 37.77, lon: -122.42 }));
    const outcome = await applyGeoDefaultIfNeeded({ fetchImpl, now: fixedNow });
    expect(outcome.kind).toBe('none');
    expect(getUserLocation()).toBeNull();
  });

  it('reports kind=none and persists nothing when /v1/geo fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const outcome = await applyGeoDefaultIfNeeded({ fetchImpl, now: fixedNow });
    expect(outcome.kind).toBe('none');
    expect(getUserLocation()).toBeNull();
  });
});
