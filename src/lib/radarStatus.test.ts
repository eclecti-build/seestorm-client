import { describe, it, expect } from 'vitest';
import {
  INITIAL_RADAR_STATUS,
  LIVE_REFRESH_RESTART_MS,
  RADAR_LOADING_GRACE_MS,
  RADAR_REFRESH_GRACE_MS,
  nextRadarDeadline,
  radarIndicator,
  radarSourceIdOf,
  radarStatusReducer,
  shouldRestartLiveRefresh,
  type RadarStatusAction,
  type RadarStatusState,
} from './radarStatus';

function run(actions: RadarStatusAction[], from = INITIAL_RADAR_STATUS): RadarStatusState {
  return actions.reduce(radarStatusReducer, from);
}

describe('radarIndicator', () => {
  it('renders nothing when radar is healthy', () => {
    expect(radarIndicator(INITIAL_RADAR_STATUS, 0)).toBeNull();
  });

  it('stays hidden inside the loading grace period', () => {
    const s = run([{ type: 'loadStarted', at: 1000 }]);
    expect(radarIndicator(s, 1000)).toBeNull();
    expect(radarIndicator(s, 1000 + RADAR_LOADING_GRACE_MS - 1)).toBeNull();
  });

  it('shows loading once the grace period has elapsed', () => {
    const s = run([{ type: 'loadStarted', at: 1000 }]);
    expect(radarIndicator(s, 1000 + RADAR_LOADING_GRACE_MS)).toBe('loading');
  });

  it('never flashes for a healthy fast load', () => {
    const s = run([
      { type: 'loadStarted', at: 1000 },
      { type: 'tileLoaded' },
      { type: 'loadSettled' },
    ]);
    expect(radarIndicator(s, 1000 + RADAR_LOADING_GRACE_MS * 10)).toBeNull();
  });

  it('shows an error immediately, with no grace period', () => {
    const s = run([{ type: 'loadStarted', at: 1000 }, { type: 'tileErrored' }]);
    expect(radarIndicator(s, 1000)).toBe('error');
  });

  it('error takes precedence over loading', () => {
    const s = run([{ type: 'loadStarted', at: 0 }, { type: 'tileErrored' }]);
    expect(radarIndicator(s, RADAR_LOADING_GRACE_MS * 2)).toBe('error');
  });
});

describe('radarStatusReducer', () => {
  it('keeps the first load start when per-tile starts stream in', () => {
    const s = run([
      { type: 'loadStarted', at: 1000 },
      { type: 'loadStarted', at: 1500 },
    ]);
    expect(s.loadingSince).toBe(1000);
  });

  it('keeps the error through the settle of the load that errored', () => {
    const s = run([
      { type: 'loadStarted', at: 0 },
      { type: 'tileErrored' },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(true);
    expect(s.loadingSince).toBeNull();
  });

  it('clears the error when a later load completes with no tile errors', () => {
    const s = run([
      { type: 'loadStarted', at: 0 },
      { type: 'tileErrored' },
      { type: 'loadSettled' },
      { type: 'loadStarted', at: 5000 },
      { type: 'tileLoaded' },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(false);
    expect(radarIndicator(s, 10_000)).toBeNull();
  });

  it('does not clear the error when the later load also errors', () => {
    const s = run([
      { type: 'tileErrored' },
      { type: 'loadStarted', at: 5000 },
      { type: 'tileErrored' },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(true);
  });

  it('a settle with no open load cycle never clears the error', () => {
    const s = run([{ type: 'tileErrored' }, { type: 'loadSettled' }, { type: 'loadSettled' }]);
    expect(s.errored).toBe(true);
  });

  it('a clean gated live refresh clears the error', () => {
    const s = run([{ type: 'tileErrored' }, { type: 'refreshSucceeded' }]);
    expect(s.errored).toBe(false);
  });

  it('returns the same state object for no-op actions so React can bail out', () => {
    const loading = run([{ type: 'loadStarted', at: 1 }]);
    expect(radarStatusReducer(loading, { type: 'loadStarted', at: 2 })).toBe(loading);
    expect(radarStatusReducer(INITIAL_RADAR_STATUS, { type: 'loadSettled' })).toBe(
      INITIAL_RADAR_STATUS,
    );
    expect(radarStatusReducer(INITIAL_RADAR_STATUS, { type: 'refreshSucceeded' })).toBe(
      INITIAL_RADAR_STATUS,
    );
  });
});

describe('silent tile failures (HTTP 404 fires no error event)', () => {
  it('a load that settles with no tile loaded surfaces as an error', () => {
    const s = run([{ type: 'loadStarted', at: 0 }, { type: 'loadSettled' }]);
    expect(s.errored).toBe(true);
    expect(radarIndicator(s, 0)).toBe('error');
  });

  it('an all-404 frame change surfaces as an error', () => {
    const s = run([{ type: 'frameChanged', at: 0 }, { type: 'loadSettled' }]);
    expect(radarIndicator(s, 0)).toBe('error');
  });

  it('a success on the previous frame does not count for the new one', () => {
    const s = run([
      { type: 'frameChanged', at: 0 },
      { type: 'tileLoaded' },
      { type: 'frameChanged', at: 200 },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(true);
  });

  it('one successful tile (e.g. a transparent no-rain tile) is a clean load', () => {
    const s = run([
      { type: 'loadStarted', at: 0 },
      { type: 'tileLoaded' },
      { type: 'tileLoaded' },
      { type: 'loadSettled' },
    ]);
    expect(radarIndicator(s, 10_000)).toBeNull();
  });

  it('a cycle whose only requests were aborted neither raises nor clears the error', () => {
    const aborted: RadarStatusAction[] = [
      { type: 'loadStarted', at: 0 },
      { type: 'tileAborted' },
      { type: 'loadSettled' },
    ];
    expect(run(aborted).errored).toBe(false);
    expect(run([{ type: 'tileErrored' }, ...aborted]).errored).toBe(true);
  });

  it('a successful load outside an open cycle carries into nothing', () => {
    const s = run([
      { type: 'tileLoaded' },
      { type: 'loadStarted', at: 0 },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(true);
    expect(radarStatusReducer(INITIAL_RADAR_STATUS, { type: 'tileLoaded' })).toBe(
      INITIAL_RADAR_STATUS,
    );
  });
});

describe('radarSourceIdOf', () => {
  it('attributes an error event to a radar source via sourceId', () => {
    expect(radarSourceIdOf({ sourceId: 'radar-a', tile: {} })).toBe('radar-a');
    expect(radarSourceIdOf({ sourceId: 'radar-b' })).toBe('radar-b');
  });

  it('ignores non-radar and source-less errors', () => {
    expect(radarSourceIdOf({ sourceId: 'alerts' })).toBeNull();
    expect(radarSourceIdOf({ error: new Error('glyphs') })).toBeNull();
    expect(radarSourceIdOf({ sourceId: 42 })).toBeNull();
  });
});

describe('shouldRestartLiveRefresh', () => {
  it('starts when nothing is in flight', () => {
    expect(shouldRestartLiveRefresh(null, 0)).toBe(true);
  });

  it('leaves a younger in-flight refresh alone', () => {
    expect(shouldRestartLiveRefresh(0, 30_000)).toBe(false);
    expect(shouldRestartLiveRefresh(0, LIVE_REFRESH_RESTART_MS - 1)).toBe(false);
  });

  it('restarts once the in-flight refresh is older than the limit', () => {
    expect(shouldRestartLiveRefresh(0, LIVE_REFRESH_RESTART_MS)).toBe(true);
  });
});

describe('gated live refresh (hung host surfaces as dots)', () => {
  it('uses the longer refresh grace: hidden at 4.9 s, shown at 5 s', () => {
    expect(RADAR_REFRESH_GRACE_MS).toBe(5_000);
    const s = run([{ type: 'refreshStarted', at: 0 }]);
    expect(radarIndicator(s, 4_900)).toBeNull();
    expect(radarIndicator(s, 5_000)).toBe('loading');
  });

  it('a restart of a stalled refresh does not reset the clock', () => {
    const s = run([
      { type: 'refreshStarted', at: 0 },
      { type: 'refreshStarted', at: 60_000 },
    ]);
    expect(s.refreshSince).toBe(0);
    expect(radarIndicator(s, 60_000)).toBe('loading');
  });

  it('leaving live mode clears the refresh clock', () => {
    const s = run([{ type: 'refreshStarted', at: 0 }, { type: 'refreshAbandoned' }]);
    expect(s.refreshSince).toBeNull();
    expect(radarIndicator(s, 10_000)).toBeNull();
  });

  it('a successful refresh clears both the clock and the error', () => {
    const s = run([
      { type: 'refreshStarted', at: 0 },
      { type: 'tileErrored' },
      { type: 'refreshSucceeded' },
    ]);
    expect(s.refreshSince).toBeNull();
    expect(s.errored).toBe(false);
    expect(radarIndicator(s, 10_000)).toBeNull();
  });

  it('a refresh swapped in after a hung on-screen load closes that load cycle', () => {
    // Host hangs while the on-screen source loads; it recovers and the hidden
    // refresh swaps in. The old source's hung requests mean no settle arrives.
    const s = run([
      { type: 'loadStarted', at: 0 },
      { type: 'refreshStarted', at: 30_000 },
      { type: 'refreshSucceeded' },
    ]);
    expect(s.loadingSince).toBeNull();
    expect(radarIndicator(s, 31_000)).toBeNull();
    expect(nextRadarDeadline(s, 31_000)).toBeNull();
  });

  it('error takes precedence over a slow refresh', () => {
    const s = run([{ type: 'refreshStarted', at: 0 }, { type: 'tileErrored' }]);
    expect(radarIndicator(s, 0)).toBe('error');
    expect(radarIndicator(s, 10_000)).toBe('error');
  });

  it('a clean pan does not turn a failing live refresh back into "loading"', () => {
    // The refresh errors (and is cancelled, keeping its clock); a pan then
    // loads the on-screen source cleanly, clearing the on-screen error.
    const s = run([
      { type: 'refreshStarted', at: 0 },
      { type: 'tileErrored', refresh: true },
      { type: 'loadStarted', at: 1_000 },
      { type: 'tileLoaded' },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(false);
    expect(radarIndicator(s, 10_000)).toBe('error');
  });

  it('the refresh error clears once a later refresh succeeds or live is left', () => {
    const failed = run([
      { type: 'refreshStarted', at: 0 },
      { type: 'tileErrored', refresh: true },
    ]);
    expect(radarIndicator(run([{ type: 'refreshSucceeded' }], failed), 40_000)).toBeNull();
    const left = run([{ type: 'refreshAbandoned' }], failed);
    expect(left.refreshErrored).toBe(false);
  });

  it('an on-screen error during a refresh is not pinned to the refresh', () => {
    const s = run([
      { type: 'refreshStarted', at: 0 },
      { type: 'tileErrored' },
      { type: 'loadStarted', at: 1_000 },
      { type: 'tileLoaded' },
      { type: 'loadSettled' },
    ]);
    expect(s.refreshErrored).toBe(false);
  });
});

describe('frameChanged', () => {
  it('an unsettled error on frame A does not stick to a clean frame B', () => {
    const s = run([
      { type: 'frameChanged', at: 0 },
      { type: 'tileErrored' },
      { type: 'frameChanged', at: 200 },
      { type: 'tileLoaded' },
      { type: 'loadSettled' },
    ]);
    expect(s.errored).toBe(false);
    expect(radarIndicator(s, 1_000)).toBeNull();
  });

  it('keeps the error until the new frame settles', () => {
    const s = run([
      { type: 'frameChanged', at: 0 },
      { type: 'tileErrored' },
      { type: 'frameChanged', at: 200 },
    ]);
    expect(radarIndicator(s, 200)).toBe('error');
  });

  it('keeps an already-running loading clock so fast playback still reaches the grace', () => {
    const s = run([
      { type: 'frameChanged', at: 0 },
      { type: 'frameChanged', at: 250 },
      { type: 'frameChanged', at: 500 },
    ]);
    expect(s.loadingSince).toBe(0);
    expect(radarIndicator(s, RADAR_LOADING_GRACE_MS)).toBe('loading');
  });

  it('starts the clock when nothing was loading', () => {
    expect(run([{ type: 'frameChanged', at: 42 }]).loadingSince).toBe(42);
  });
});

describe('nextRadarDeadline', () => {
  it('is null when nothing is pending', () => {
    expect(nextRadarDeadline(INITIAL_RADAR_STATUS, 0)).toBeNull();
  });

  it('returns the earlier unseen deadline, then the later one', () => {
    const s = run([
      { type: 'refreshStarted', at: 0 },
      { type: 'loadStarted', at: 100 },
    ]);
    expect(nextRadarDeadline(s, 0)).toBe(100 + RADAR_LOADING_GRACE_MS);
    expect(nextRadarDeadline(s, 100 + RADAR_LOADING_GRACE_MS)).toBe(RADAR_REFRESH_GRACE_MS);
    expect(nextRadarDeadline(s, RADAR_REFRESH_GRACE_MS)).toBeNull();
  });
});
