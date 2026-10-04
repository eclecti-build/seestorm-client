// Iowa Environmental Mesonet NEXRAD composite tile URLs.
//
// Live:        nexrad-n0q-900913 (always current)
// Historical:  ridge::USCOMP-N0Q-YYYYMMDDHHMI (5-min UTC snap blocks)
//
// The Mesonet archive retains composites for years, well beyond anything we
// need. Single-site `BMX-N0Q-*` is for one radar; we always want the national
// composite. The server rounds non-5-min-aligned timestamps internally, but we
// round client-side anyway so the tile URL is stable across clients — better
// CDN / browser cache hit rate.
//
// The URLs use a custom scheme, not https: MapLibre hands them to
// `loadRadarTile` (registered via `addProtocol`), which fetches the https
// tile itself — see radarTileLoader.ts for why.

export const RADAR_TILE_PROTOCOL = 'seestorm-radar';

const IEM_TILE_BASE = `${RADAR_TILE_PROTOCOL}://mesonet.agron.iastate.edu/cache/tile.py/1.0.0`;

const LIVE_TILE_PREFIX = `${IEM_TILE_BASE}/nexrad-n0q-900913/`;

const LIVE_TILE_URL = `${LIVE_TILE_PREFIX}{z}/{x}/{y}.png`;

const FIVE_MIN_MS = 5 * 60_000;

// HRRR forecast reflectivity is emitted at 15-min increments up to 18h. The
// `-0` suffix means "use the latest completed model run" so we don't have to
// track run init times client-side. Horizon + step are exposed so the caller
// can decide how far out to project.
export const HRRR_STEP_MINUTES = 15;
export const HRRR_HORIZON_MINUTES = 60;
export const HRRR_FRAME_COUNT = HRRR_HORIZON_MINUTES / HRRR_STEP_MINUTES;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function pad4(n: number): string {
  return n.toString().padStart(4, '0');
}

/**
 * Returns the MapLibre tile URL template for the NEXRAD N0Q composite at the
 * given time. Pass `'live'` for the rolling-current layer. Historical times
 * are rounded DOWN to the previous 5-minute block in UTC.
 */
export function radarTileUrl(at: Date | 'live'): string {
  if (at === 'live') return LIVE_TILE_URL;

  const snapped = new Date(Math.floor(at.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS);
  const ts =
    snapped.getUTCFullYear().toString() +
    pad2(snapped.getUTCMonth() + 1) +
    pad2(snapped.getUTCDate()) +
    pad2(snapped.getUTCHours()) +
    pad2(snapped.getUTCMinutes());

  return `${IEM_TILE_BASE}/ridge::USCOMP-N0Q-${ts}/{z}/{x}/{y}.png`;
}

/**
 * Whether a concrete tile URL (template filled in) belongs to the live
 * composite layer, as opposed to a historical or HRRR forecast frame.
 */
export function isLiveRadarTileUrl(url: string): boolean {
  return url.startsWith(LIVE_TILE_PREFIX);
}

/**
 * Returns the MapLibre tile URL template for HRRR model forecast reflectivity
 * at `minutesAhead` minutes beyond the latest model run. HRRR emits frames at
 * 15-min cadence; callers are expected to pass multiples of HRRR_STEP_MINUTES.
 *
 * This is a MODEL FORECAST, not an observation — surface that clearly to users.
 */
export function hrrrTileUrl(minutesAhead: number): string {
  if (minutesAhead < 0) throw new Error('hrrrTileUrl: minutesAhead must be >= 0');
  const snapped = Math.round(minutesAhead / HRRR_STEP_MINUTES) * HRRR_STEP_MINUTES;
  return `${IEM_TILE_BASE}/hrrr::REFD-F${pad4(snapped)}-0/{z}/{x}/{y}.png`;
}
