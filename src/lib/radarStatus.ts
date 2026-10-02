// Pure state machine behind the radar status indicator (three pulsing dots).
//
// Radar tiles come from a third-party host (Iowa Mesonet). Two things are
// worth surfacing to the user, and nothing else:
//   - "loading": the radar on screen has been fetching tiles for longer than
//     a short grace period, so a blank map doesn't read as "clear skies".
//     Healthy refreshes (~100 ms) finish inside the grace and never flash it.
//   - "error": a radar tile request failed. Shown immediately, and cleared
//     only once a later radar load completes with zero tile errors. Also
//     raised when a load settles with no tile loaded at all: MapLibre fires
//     no `error` for an HTTP 404 yet counts the tile as settled, so an
//     all-404 frame would otherwise clear the dots over blank radar.
//
// WeatherMap feeds MapLibre events in as actions; the selector takes `now`
// so the grace period is testable without timers.

export const RADAR_SOURCE_IDS = ['radar-a', 'radar-b'] as const;
export type RadarSourceId = (typeof RADAR_SOURCE_IDS)[number];

// How long the on-screen radar may load before the dots appear.
export const RADAR_LOADING_GRACE_MS = 600;

// How long a gated live refresh may run before the dots appear. Longer than
// the on-screen grace on purpose: the radar on screen is still good during a
// refresh, and a slow phone connection must not flash dots every 30s poll.
// It exists so a hung host (connection accepted, never answered) surfaces
// instead of the on-screen radar silently going stale under a LIVE label.
export const RADAR_REFRESH_GRACE_MS = 5_000;

// A gated live refresh still in flight is left alone by the next 30s poll
// (restarting it would mean a slow host never finishes). Only once it is this
// old is it abandoned and a fresh one started.
export const LIVE_REFRESH_RESTART_MS = 60_000;

export interface RadarStatusState {
  // When the current on-screen load began; null when nothing is loading.
  loadingSince: number | null;
  // Sticky error flag shown to the user.
  errored: boolean;
  // Whether a tile errored during the current (or most recent) load cycle.
  // A settle only clears `errored` when this is false.
  loadErrored: boolean;
  // Whether a tile loaded successfully during the current load cycle. A
  // healthy frame with no rain still returns transparent tiles, which count.
  loadSucceeded: boolean;
  // Whether a tile request was aborted (panned out of view) during the
  // current load cycle — a settle then proves neither success nor failure.
  loadAborted: boolean;
  // When the current gated live refresh began; null when none is in flight.
  refreshSince: number | null;
}

export type RadarStatusAction =
  // The on-screen radar source started fetching tiles.
  | { type: 'loadStarted'; at: number }
  // The on-screen radar source has no outstanding tile requests.
  | { type: 'loadSettled' }
  // A radar tile request failed.
  | { type: 'tileErrored' }
  // A radar tile loaded successfully.
  | { type: 'tileLoaded' }
  // A radar tile request was aborted before it finished.
  | { type: 'tileAborted' }
  // The on-screen frame changed (historical/forecast step, entering live):
  // a fresh error-tracking cycle for the new frame.
  | { type: 'frameChanged'; at: number }
  // A gated live refresh began loading into the hidden source.
  | { type: 'refreshStarted'; at: number }
  // A gated live refresh loaded every tile cleanly and was swapped in.
  | { type: 'refreshSucceeded' }
  // A gated live refresh was dropped because live mode was left.
  | { type: 'refreshAbandoned' };

export type RadarIndicator = 'loading' | 'error' | null;

export const INITIAL_RADAR_STATUS: RadarStatusState = {
  loadingSince: null,
  errored: false,
  loadErrored: false,
  loadSucceeded: false,
  loadAborted: false,
  refreshSince: null,
};

// Per-cycle tile bookkeeping, reset whenever a load cycle opens.
const FRESH_CYCLE = { loadErrored: false, loadSucceeded: false, loadAborted: false } as const;

export function radarStatusReducer(
  state: RadarStatusState,
  action: RadarStatusAction,
): RadarStatusState {
  switch (action.type) {
    case 'loadStarted':
      // Per-tile loading events stream in; only the first opens the cycle.
      if (state.loadingSince !== null) return state;
      return { ...state, ...FRESH_CYCLE, loadingSince: action.at };
    case 'loadSettled': {
      // A settle with no open cycle (e.g. repeat completion events) proves
      // nothing about a clean load, so it never clears the error.
      if (state.loadingSince === null) return state;
      let errored = state.errored;
      if (state.loadErrored) errored = true;
      else if (state.loadSucceeded) errored = false;
      // Nothing loaded and nothing aborted: every tile failed silently (404).
      else if (!state.loadAborted) errored = true;
      return { ...state, loadingSince: null, errored };
    }
    case 'tileErrored':
      if (state.errored && state.loadErrored) return state;
      return { ...state, errored: true, loadErrored: true };
    case 'tileLoaded':
      if (state.loadingSince === null || state.loadSucceeded) return state;
      return { ...state, loadSucceeded: true };
    case 'tileAborted':
      if (state.loadingSince === null || state.loadAborted) return state;
      return { ...state, loadAborted: true };
    case 'frameChanged':
      // Unlike loadStarted, always opens a fresh error cycle — an error in the
      // previous frame must not stick to a new frame that loads cleanly. An
      // already-running clock is kept so fast playback against a slow host
      // still reaches the grace threshold.
      return { ...state, ...FRESH_CYCLE, loadingSince: state.loadingSince ?? action.at };
    case 'refreshStarted':
      // A 60s restart of a stalled refresh keeps the original clock, so the
      // dots don't blink off.
      if (state.refreshSince !== null) return state;
      return { ...state, refreshSince: action.at };
    case 'refreshSucceeded':
      // The swapped-in source was just verified fully loaded with no tile
      // errors, so it also closes any on-screen load cycle: the old source may
      // still hold hung requests that keep `idle` from ever settling it.
      if (!state.errored && state.refreshSince === null && state.loadingSince === null) {
        return state;
      }
      return {
        ...state,
        errored: false,
        ...FRESH_CYCLE,
        loadingSince: null,
        refreshSince: null,
      };
    case 'refreshAbandoned':
      if (state.refreshSince === null) return state;
      return { ...state, refreshSince: null };
  }
}

export function radarIndicator(state: RadarStatusState, now: number): RadarIndicator {
  if (state.errored) return 'error';
  if (state.loadingSince !== null && now - state.loadingSince >= RADAR_LOADING_GRACE_MS) {
    return 'loading';
  }
  if (state.refreshSince !== null && now - state.refreshSince >= RADAR_REFRESH_GRACE_MS) {
    return 'loading';
  }
  return null;
}

// MapLibre's map-level `error` event carries the failing source's id as
// `sourceId` (merged in by the Style's evented-parent data) — it is not on
// the published ErrorEvent type, so read it defensively. Returns the radar
// source id, or null for any non-radar error.
export function radarSourceIdOf(event: object): RadarSourceId | null {
  const { sourceId } = event as { sourceId?: unknown };
  return RADAR_SOURCE_IDS.find((id) => id === sourceId) ?? null;
}

// The next instant at which the selector's answer can change on its own (a
// grace period elapsing), or null when no deadline is pending. WeatherMap
// schedules its wake-up timer for this.
export function nextRadarDeadline(state: RadarStatusState, now: number): number | null {
  const deadlines = [
    state.loadingSince === null ? null : state.loadingSince + RADAR_LOADING_GRACE_MS,
    state.refreshSince === null ? null : state.refreshSince + RADAR_REFRESH_GRACE_MS,
  ].filter((d): d is number => d !== null && d > now);
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

// Whether the next live poll may abandon an in-flight gated refresh.
export function shouldRestartLiveRefresh(startedAt: number | null, now: number): boolean {
  return startedAt === null || now - startedAt >= LIVE_REFRESH_RESTART_MS;
}
