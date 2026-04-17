import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupZip, normalizeZip } from './zipLookup';

describe('normalizeZip', () => {
  it('accepts a 5-digit ZIP', () => {
    expect(normalizeZip('53703')).toBe('53703');
  });

  it('strips ZIP+4 suffix', () => {
    expect(normalizeZip('53703-1234')).toBe('53703');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeZip('  53703  ')).toBe('53703');
  });

  it('rejects non-numeric input', () => {
    expect(normalizeZip('hello')).toBeNull();
  });

  it('rejects too-short / too-long inputs', () => {
    expect(normalizeZip('123')).toBeNull();
    expect(normalizeZip('123456')).toBeNull();
  });

  it('rejects malformed ZIP+4', () => {
    expect(normalizeZip('53703-')).toBeNull();
    expect(normalizeZip('53703-12')).toBeNull();
  });
});

// Module-state isolation: zipLookup keeps a module-scoped `tablePromise`.
// Reset it between tests by re-importing the module so retries-after-failure
// can be observed independent of test ordering.
describe('lookupZip retry-after-failure', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not cache a rejected fetch — a second call retries', async () => {
    // First call: fetch rejects with 500. Second call: fetch returns a real
    // table containing 53703. The cached rejected promise must NOT win.
    const fetchMock = vi
      .fn()
      // First attempt — server hiccup.
      .mockResolvedValueOnce(
        new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      )
      // Second attempt — works.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            '53703': { lat: 43.07, lon: -89.4, state: 'WI', county: 'Dane' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Re-import after the mock is wired so the module captures the mocked fetch.
    const { lookupZip: lookupZipFresh } = await import('./zipLookup');

    await expect(lookupZipFresh('53703')).rejects.toThrow(/ZIP table fetch failed/);
    // If the rejected promise stayed cached, this would re-throw instead of
    // resolving to the record.
    await expect(lookupZipFresh('53703')).resolves.toEqual({
      lat: 43.07,
      lon: -89.4,
      state: 'WI',
      county: 'Dane',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Light type-check: ensure the public surface still exports lookupZip.
describe('zipLookup public surface', () => {
  it('exports lookupZip', () => {
    expect(typeof lookupZip).toBe('function');
  });
});
