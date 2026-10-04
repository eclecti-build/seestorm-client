import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hrrrTileUrl, radarTileUrl } from './radar';
import {
  LIVE_TILE_CACHE_CONTROL,
  loadRadarTile,
  RadarTileError,
  setLiveRadarActive,
} from './radarTileLoader';

const TILE = radarTileUrl('live').replace('{z}/{x}/{y}', '4/3/6');
const HISTORICAL_TILE = radarTileUrl(new Date(Date.UTC(2026, 9, 2, 11, 0))).replace(
  '{z}/{x}/{y}',
  '4/3/6',
);
const HTTPS_TILE =
  'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/4/3/6.png';
const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300',
  Expires: 'Thu, 01 Jan 2026 00:00:00 GMT',
};

function okResponse() {
  return Promise.resolve(
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: CACHE_HEADERS }),
  );
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  setLiveRadarActive(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLiveRadarActive(false);
});

describe('loadRadarTile', () => {
  it('fetches a live tile and replaces its cache headers with a far-future max-age', async () => {
    const fetchMock = mockFetch(okResponse);
    const controller = new AbortController();

    const result = await loadRadarTile({ url: TILE }, controller);

    expect(fetchMock).toHaveBeenCalledWith(HTTPS_TILE, { signal: controller.signal });
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
    // Never the host's 5-minute header, so MapLibre never expires the tile.
    expect(result.cacheControl).toBe(LIVE_TILE_CACHE_CONTROL);
    expect(result.expires).toBeUndefined();
  });

  it('gives a live tile the far-future max-age even when the host sends none', async () => {
    mockFetch(() => Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })));

    const result = await loadRadarTile({ url: TILE }, new AbortController());

    expect(result.cacheControl).toBe(LIVE_TILE_CACHE_CONTROL);
  });

  it.each([
    ['historical', radarTileUrl(new Date(Date.UTC(2026, 3, 17, 4, 45)))],
    // `-0` = latest model run: expiry is what picks up a new run.
    ['HRRR forecast', hrrrTileUrl(60)],
  ])('passes a %s tile its cache headers as MapLibre would', async (_kind, template) => {
    const fetchMock = mockFetch(okResponse);
    const url = template.replace('{z}/{x}/{y}', '4/3/6');

    const result = await loadRadarTile({ url }, new AbortController());

    expect(fetchMock.mock.calls[0][0]).toBe(url.replace('seestorm-radar://', 'https://'));
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.cacheControl).toBe(CACHE_HEADERS['Cache-Control']);
    expect(result.expires).toBe(CACHE_HEADERS.Expires);
  });

  // Live URL x live mode: the only combination that gets the far-future header.
  it.each([
    ['live tile, live mode', TILE, true, LIVE_TILE_CACHE_CONTROL],
    ['live tile, not live mode (straggler)', TILE, false, CACHE_HEADERS['Cache-Control']],
    ['historical tile, live mode', HISTORICAL_TILE, true, CACHE_HEADERS['Cache-Control']],
    ['historical tile, not live mode', HISTORICAL_TILE, false, CACHE_HEADERS['Cache-Control']],
  ])('%s', async (_name, url, live, cacheControl) => {
    mockFetch(okResponse);
    setLiveRadarActive(live);

    const result = await loadRadarTile({ url }, new AbortController());

    expect(result.cacheControl).toBe(cacheControl);
    expect(result.expires).toBe(
      cacheControl === LIVE_TILE_CACHE_CONTROL ? undefined : CACHE_HEADERS.Expires,
    );
  });

  it('reads live mode when the response completes, not when the request starts', async () => {
    let finish: (r: Response) => void = () => {};
    mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)));

    // Starts in live mode; the app leaves live mode while it is in flight.
    const pending = loadRadarTile({ url: TILE }, new AbortController());
    setLiveRadarActive(false);
    finish(await okResponse());

    expect((await pending).cacheControl).toBe(CACHE_HEADERS['Cache-Control']);
  });

  it('passes null cache headers through when the response has none', async () => {
    mockFetch(() => Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })));

    const result = await loadRadarTile(
      { url: hrrrTileUrl(15).replace('{z}/{x}/{y}', '4/3/6') },
      new AbortController(),
    );

    expect(result.cacheControl).toBeNull();
    expect(result.expires).toBeNull();
  });

  it('rejects an HTTP failure with its status', async () => {
    mockFetch(() => Promise.resolve(new Response('busy', { status: 503, statusText: 'Busy' })));

    const err = await loadRadarTile({ url: TILE }, new AbortController()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RadarTileError);
    expect((err as RadarTileError).status).toBe(503);
  });

  it('keeps 404 distinguishable (MapLibre fires no error event for it)', async () => {
    mockFetch(() => Promise.resolve(new Response('', { status: 404 })));

    const err = await loadRadarTile({ url: TILE }, new AbortController()).catch((e: unknown) => e);

    expect((err as RadarTileError).status).toBe(404);
  });

  it('reports a network failure as status 0', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    const err = await loadRadarTile({ url: TILE }, new AbortController()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RadarTileError);
    expect((err as RadarTileError).status).toBe(0);
  });

  it('rethrows an abort unchanged', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    const controller = new AbortController();
    mockFetch(() => {
      controller.abort();
      return Promise.reject(abortError);
    });

    await expect(loadRadarTile({ url: TILE }, controller)).rejects.toBe(abortError);
  });
});

// Canary against MapLibre internals (maplibre-gl 5.23.0). `setTiles` reloads
// in-view tiles in place, and the loader's expiry handling depends on:
//   - tile/tile.ts `Tile.setExpiryData` and `Tile.getExpiryTimeout` (imported
//     for real below), and
//   - source/raster_tile_source.ts `loadTile`, which only calls
//     `setExpiryData` when the response carries `cacheControl` or `expires`
//     (mirrored by `applyLoad`).
// `maplibre-gl/src/` is not public API. A MapLibre upgrade that moves or
// changes these fails this suite on purpose: re-verify the loader's expiry
// assumptions (see radarTileLoader.ts) against the new version, then update
// the import path and `applyLoad`. Imported by a runtime path so tsc doesn't
// type-check MapLibre's sources under our config.
const MAPLIBRE_TILE_MODULE = 'maplibre-gl/src/tile/tile';
interface MapLibreTile {
  setExpiryData(data: { cacheControl?: string | null; expires?: Date | string | null }): void;
  getExpiryTimeout(): number | undefined;
}
type MapLibreTileClass = new (tileID: unknown, size: number) => MapLibreTile;

describe('loadRadarTile with a reused MapLibre Tile', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Mirrors the raster source's guard around `setExpiryData`.
  function applyLoad(
    tile: MapLibreTile,
    result: { cacheControl?: string | null; expires?: Date | string | null },
  ) {
    if (result.cacheControl || result.expires) {
      tile.setExpiryData({ cacheControl: result.cacheControl, expires: result.expires });
    }
  }

  it('replaces the 5-minute expiry inherited from a historical frame (live -> historical -> live)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const { Tile } = (await import(/* @vite-ignore */ MAPLIBRE_TILE_MODULE)) as {
      Tile: MapLibreTileClass;
    };
    const tile = new Tile({}, 512);
    mockFetch(okResponse);

    applyLoad(tile, await loadRadarTile({ url: TILE }, new AbortController()));
    applyLoad(tile, await loadRadarTile({ url: HISTORICAL_TILE }, new AbortController()));
    expect(tile.getExpiryTimeout()).toBe(300_000);

    // Back to live, after the historical frame's expiry has passed.
    vi.setSystemTime(Date.now() + 301_000);
    applyLoad(tile, await loadRadarTile({ url: TILE }, new AbortController()));

    // A far-future timer (capped by MapLibre at the setTimeout maximum), not
    // a past-due one that would schedule an immediate expiry reload.
    expect(tile.getExpiryTimeout()).toBe(2 ** 31 - 1);
  });

  // `setTiles` doesn't abort a tile's in-flight request: a slow live response
  // can land after the tile was reloaded with a historical URL. Out of live
  // mode it keeps the host's 5-minute expiry, so MapLibre re-fetches the
  // tile's current (historical) URL then, rather than in a year.
  it('lets a live straggler landing on a historical frame expire in ~5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const { Tile } = (await import(/* @vite-ignore */ MAPLIBRE_TILE_MODULE)) as {
      Tile: MapLibreTileClass;
    };
    const tile = new Tile({}, 512);
    mockFetch(okResponse);

    applyLoad(tile, await loadRadarTile({ url: TILE }, new AbortController()));
    setLiveRadarActive(false);
    applyLoad(tile, await loadRadarTile({ url: HISTORICAL_TILE }, new AbortController()));
    expect(tile.getExpiryTimeout()).toBe(300_000);

    // The straggling live response lands 10 s later, still out of live mode.
    vi.setSystemTime(Date.now() + 10_000);
    applyLoad(tile, await loadRadarTile({ url: TILE }, new AbortController()));

    // A fresh 5-minute timer: not a year, and not past-due (no reload loop).
    expect(tile.getExpiryTimeout()).toBe(300_000);
  });

  // Exercises none of our code: it only proves the test above would fail
  // without the loader's far-future live header.
  it('would keep a past-due expiry if the live load carried no cache headers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    const { Tile } = (await import(/* @vite-ignore */ MAPLIBRE_TILE_MODULE)) as {
      Tile: MapLibreTileClass;
    };
    const tile = new Tile({}, 512);

    applyLoad(tile, { cacheControl: CACHE_HEADERS['Cache-Control'] });
    vi.setSystemTime(Date.now() + 301_000);
    applyLoad(tile, {});

    // Negative yet truthy: MapLibre's `if (expiryTimeout)` schedules a reload
    // at once, and each header-less live load repeats it.
    expect(tile.getExpiryTimeout()).toBeLessThan(0);
  });
});
