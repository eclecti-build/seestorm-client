// MapLibre `addProtocol` loader for radar tiles (the `seestorm-radar://` URLs
// built in radar.ts).
//
// Why it exists: Iowa Mesonet serves tiles with `Cache-Control: max-age=300`.
// Given that header, MapLibre (`refreshExpiredTiles`, on by default) re-fetches
// each on-screen tile when it expires and, if the host is down, marks the tile
// errored and stops drawing it — wiping the last good live frame ~5 minutes
// into an outage. This loader fetches the tile like MapLibre would but, for
// a live-composite tile completing while the app is in live mode, replaces its
// cache headers with a far-future `max-age` (LIVE_TILE_CACHE_CONTROL), so live
// tiles effectively never expire. Live freshness doesn't depend on expiry: the
// live view re-requests tiles itself on every live refresh tick (the gated
// `setTiles` refresh).
//
// Why "while in live mode" (`setLiveRadarActive`, driven by WeatherMap's
// radar effect): `setTiles` reloads a tile in place without aborting its
// in-flight request, so a slow live response can land on a tile that has
// since been reloaded with a historical or HRRR URL — live pixels under a
// historical label. Out of live mode no tile should hold a live frame, so a
// live response completing then is such a straggler: it keeps the host's own
// headers, and MapLibre's expiry reload (~5 minutes) re-fetches the tile's
// current URL, replacing it. In live mode every on-screen source was just
// `setTiles`-ed to the live URL, so a live response is the right frame. The
// flag is read once the response body is in, not when the request starts.
//
// Why a far-future header rather than none: `setTiles` reloads in-view
// MapLibre Tile objects in place, and MapLibre only updates a tile's expiry
// when a response carries `cacheControl` / `expires`. A header-less live load
// into a tile that last held a historical or forecast frame would keep that
// frame's 5-minute expiry; once it passed, every live load would schedule an
// immediate expiry reload — a hot re-fetch loop that, with the host down,
// errors the tile and wipes the kept live frame. An explicit header always
// overwrites the inherited expiry and resets MapLibre's expired-retry count.
//
// The loader deliberately neither retries nor times out: MapLibre owns tile
// abort/retry semantics, and recovery belongs to the gated live refresh and
// its stalled-refresh restart (LIVE_REFRESH_RESTART_MS in radarStatus.ts).
//
// Every other radar URL keeps its cache headers, exactly as MapLibre's own
// fetch would pass them. Historical frames are immutable, but HRRR forecast
// URLs (`REFD-F….-0`) mean "latest completed model run": the content behind a
// constant URL changes hourly, and only expiry re-fetches pick up a new run.
//
// Not the map option `refreshExpiredTiles: false`: it would also stop the
// basemap refreshing, and it makes MapLibre load raster tiles with <img>.
// Firefox reuses an image the same document already loaded without
// revalidating it (imgRequest::CanReuseWithoutValidation), so the constant
// live URL would never refresh; <img> also can't see a 404, turning it into
// an `error` event. Fetching here keeps MapLibre's own semantics: HTTP cache,
// a `status` on failures (404 stays silent, anything else fires `error`), and
// aborts rethrown as-is (MapLibre fires `dataabort` itself).

import type { GetResourceResponse, RequestParameters } from 'maplibre-gl';
import { isLiveRadarTileUrl, RADAR_TILE_PROTOCOL } from './radar';

// Cache-Control MapLibre sees for every live tile. One year is far past
// MapLibre's own cap: `Tile.getExpiryTimeout` clamps the reload timer to
// 2^31-1 ms (~24.8 days, the `setTimeout` maximum), so an on-screen live tile
// is expiry-reloaded at most once per ~24.8 days — never immediately, since the
// expiry is always in the future when set.
export const LIVE_TILE_CACHE_CONTROL = `max-age=${365 * 24 * 60 * 60}`;

// Whether the app is showing live radar. Set by WeatherMap's radar effect
// before it points any source at a new URL; see the header comment.
let liveRadarActive = false;

export function setLiveRadarActive(active: boolean): void {
  liveRadarActive = active;
}

// MapLibre's tile manager reads `status` off a failed load: 404 is skipped,
// anything else fires the map `error` event.
export class RadarTileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RadarTileError';
  }
}

export async function loadRadarTile(
  params: RequestParameters,
  abortController: AbortController,
): Promise<GetResourceResponse<ArrayBuffer>> {
  const url = params.url.replace(`${RADAR_TILE_PROTOCOL}://`, 'https://');
  let response: Response;
  try {
    response = await fetch(url, { signal: abortController.signal });
  } catch (err) {
    if (abortController.signal.aborted) throw err;
    // Network / CORS / DNS failure: status 0, as MapLibre's own fetch reports.
    throw new RadarTileError(0, `${err instanceof Error ? err.message : String(err)}: ${url}`);
  }
  if (!response.ok) {
    throw new RadarTileError(response.status, `${response.status} ${response.statusText}: ${url}`);
  }
  const data = await response.arrayBuffer();
  // Live, in live mode: a far-future expiry in place of the real headers, so
  // MapLibre never schedules an expiry re-fetch and any inherited expiry is
  // replaced. Checked now, after the body: a live straggler completing out of
  // live mode keeps the host's headers so its expiry reload replaces it.
  if (liveRadarActive && isLiveRadarTileUrl(params.url)) {
    return { data, cacheControl: LIVE_TILE_CACHE_CONTROL };
  }
  return {
    data,
    cacheControl: response.headers.get('Cache-Control'),
    expires: response.headers.get('Expires'),
  };
}
