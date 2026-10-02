// Pure state machine behind the radar status indicator (three pulsing dots).
//
// Radar tiles come from a third-party host (Iowa Mesonet). Two things are
// worth surfacing to the user, and nothing else:
//   - "loading": the radar on screen has been fetching tiles for longer than
//     a short grace period, so a blank map doesn't read as "clear skies".
//     Healthy refreshes (~100 ms) finish inside the grace and never flash it.
//   - "error": a radar tile request failed. Shown immediately, and cleared
//     only once a later radar load completes with zero tile errors — or, for
//     a failed gated live refresh, once a later refresh succeeds. Also
//     raised when a load settles with no tile loaded at all: MapLibre fires
//     no `error` for an HTTP 404 yet counts the tile as settled, so an
//     all-404 frame would otherwise clear the dots over blank radar.
//
// WeatherMap feeds MapLibre events in as actions; the selector takes `now`
// so the grace period is testable without timers.

import { POLL_INTERVAL_MS } from './constants';

export const RADAR_SOURCE_IDS = ['radar-a', 'radar-b'] as const;
export type RadarSourceId = (typeof RADAR_SOURCE_IDS)[number];

// How long the on-screen radar may load before the dots appear.
export const RADAR_LOADING_GRACE_MS = 600;

// How long a gated live refresh may run before the dots appear. Longer than
// the on-screen grace on purpose: the radar on screen is still good during a
// refresh, and a slow phone connection must not flash dots every live poll.
// It exists so a hung host (connection accepted, never answered) surfaces
// instead of the on-screen radar silently going stale under a LIVE label.
export const RADAR_REFRESH_GRACE_MS = 5_000;

// A gated live refresh still in flight is left alone by the next live poll
// (restarting it would mean a slow host never finishes). Only once it is this
// old is it abandoned and a fresh one started. 1.5 cycles at POLL_INTERVAL_MS
// sits between the first and second poll after the refresh starts: skipped at
// the first poll, always restarted at the second, immune to timer jitter (a
// threshold of exactly 2 cycles made the second poll a coin flip).
export const LIVE_REFRESH_RESTART_MS = 1.5 * POLL_INTERVAL_MS;

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
  // Whether a gated live refresh hit a tile error. Outlives that (cancelled)
  // refresh: it lasts until a later refresh succeeds or live mode is left.
  // Unlike `errored`, a clean on-screen load (a pan) does not clear it.
  refreshErrored: boolean;
}

export type RadarStatusAction =
  // The on-screen radar source started fetching tiles.
  | { type: 'loadStarted'; at: number }
  // The on-screen radar source has no outstanding tile requests.
  | { type: 'loadSettled' }
  // A radar tile request failed; `refresh` when it was the gated live
  // refresh's source (only sent while that refresh is in flight, i.e. after
  // its `refreshStarted`).
  | { type: 'tileErrored'; refresh?: boolean }
  // A radar tile loaded successfully.
  | { type: 'tileLoaded' }
  // A radar tile request was aborted before it finished.
  | { type: 'tileAborted' }
  // The on-screen frame changed (historical/forecast step, entering live):
  // a fresh error-tracking cycle for the new frame.
  | { type: 'frameChanged'; at: number }
  // A gated live refresh began loading into the hidden source.
  | { type: 'refreshStarted'; at: number }
  // A gated live refresh loaded at least one tile with no tile `error` events
  // and was swapped in.
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
  refreshErrored: false,
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
    case 'tileErrored': {
      const refreshErrored = state.refreshErrored || action.refresh === true;
      if (state.errored && state.loadErrored && refreshErrored === state.refreshErrored) {
        return state;
      }
      return { ...state, errored: true, loadErrored: true, refreshErrored };
    }
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
      // A restart of a stalled refresh keeps the original clock, so the
      // dots don't blink off.
      if (state.refreshSince !== null) return state;
      return { ...state, refreshSince: action.at };
    case 'refreshSucceeded':
      // The swapped-in source just settled with at least one tile loaded and
      // no tile `error` events, so it also closes any on-screen load cycle: the
      // old source may still hold hung requests that keep `idle` from ever
      // settling it.
      if (!state.errored && state.refreshSince === null && state.loadingSince === null) {
        return state;
      }
      return {
        ...state,
        errored: false,
        ...FRESH_CYCLE,
        loadingSince: null,
        refreshSince: null,
        refreshErrored: false,
      };
    case 'refreshAbandoned':
      if (state.refreshSince === null && !state.refreshErrored) return state;
      return { ...state, refreshSince: null, refreshErrored: false };
  }
}

export function radarIndicator(state: RadarStatusState, now: number): RadarIndicator {
  if (state.errored || state.refreshErrored) return 'error';
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

// Swap gate for a gated live refresh: the refresh loads into the hidden radar
// source and is swapped in only once that source has settled with at least
// one successful tile and no tile `error` event. WeatherMap feeds the hidden
// source's MapLibre events in, reading `isSourceLoaded` as `sourceLoaded`.
//
// Unlike the on-screen cycle above, tiles count only after the `content`
// event. After setTiles the source first fires `metadata` while the old tiles
// still read as loaded; the reload begins at `content`, so anything earlier
// is the previous load and proves nothing about the refresh. The on-screen
// path can't wait for `content`: its cycles are also opened by pans, which
// load tiles without one — so it only skips settling on `metadata`.
export interface RefreshGate {
  // The reload has begun (`content` seen); earlier events are stale.
  contentSeen: boolean;
  // A tile loaded successfully since the reload began. Required because
  // MapLibre fires no `error` for an HTTP 404 yet counts it as settled, so an
  // all-404 refresh would otherwise swap a blank frame in.
  tileLoaded: boolean;
  // A tile request failed: this refresh never swaps.
  errored: boolean;
}

export type RefreshGateEvent =
  // A `sourcedata` event from the hidden source; `tile` when it carries one
  // (a successful tile load).
  | { type: 'sourceData'; sourceDataType?: string; tile: boolean; sourceLoaded: boolean }
  // The map went idle — backstop for a final tile that settles without a
  // `sourcedata` event (e.g. a 404 among good tiles).
  | { type: 'idle'; sourceLoaded: boolean }
  // A map `error` event attributed to the hidden source.
  | { type: 'tileErrored' };

export const INITIAL_REFRESH_GATE: RefreshGate = {
  contentSeen: false,
  tileLoaded: false,
  errored: false,
};

export function refreshGateStep(
  gate: RefreshGate,
  event: RefreshGateEvent,
): { gate: RefreshGate; swap: boolean } {
  let next = gate;
  if (event.type === 'tileErrored') next = { ...gate, errored: true };
  else if (event.type === 'sourceData') {
    const contentSeen = gate.contentSeen || event.sourceDataType === 'content';
    const tileLoaded = gate.tileLoaded || (contentSeen && event.tile);
    if (contentSeen !== gate.contentSeen || tileLoaded !== gate.tileLoaded) {
      next = { ...gate, contentSeen, tileLoaded };
    }
  }
  const swap =
    event.type !== 'tileErrored' &&
    event.sourceLoaded &&
    next.contentSeen &&
    next.tileLoaded &&
    !next.errored;
  return { gate: next, swap };
}

// Whether the next live poll may abandon an in-flight gated refresh.
export function shouldRestartLiveRefresh(startedAt: number, now: number): boolean {
  return now - startedAt >= LIVE_REFRESH_RESTART_MS;
}
