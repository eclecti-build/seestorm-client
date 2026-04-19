/**
 * StalenessBanner threshold + rendering tests.
 *
 * Swarm audit 2026-04-18, Tier 1 #2c; Open Decisions #11 (binary model,
 * no middle tier — FRESH renders nothing, BROKEN renders red banner).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import StalenessBanner, { isStale } from './StalenessBanner';
import { STALENESS_BANNER_COPY, STALENESS_CRITICAL_MS } from '@/lib/constants';
import { __resetSnapshotStoreForTests, publishSnapshot } from '@/lib/snapshotStore';

describe('isStale', () => {
  it('returns false when delta < threshold', () => {
    expect(isStale(1_000_000, 1_000_000 + 89_999)).toBe(false);
  });

  it('returns true exactly at the 90_000ms threshold', () => {
    expect(isStale(1_000_000, 1_000_000 + 90_000)).toBe(true);
  });

  it('returns true well past the threshold', () => {
    expect(isStale(1_000_000, 1_000_000 + 300_000)).toBe(true);
  });

  it('returns false when generated_at_ms is null (no fetch yet)', () => {
    expect(isStale(null, Date.now())).toBe(false);
  });

  it('returns false for non-finite generated_at_ms (malformed payload)', () => {
    expect(isStale(Number.NaN, Date.now())).toBe(false);
  });
});

describe('StalenessBanner (prop-driven)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when fresh (delta = 0)', () => {
    const nowMs = 1_700_000_000_000;
    render(<StalenessBanner generatedAtMs={nowMs} serverNow={() => nowMs} tickMs={10_000} />);
    expect(screen.queryByTestId('staleness-banner')).toBeNull();
  });

  it('renders nothing at 89_999ms (1ms below threshold)', () => {
    const gen = 1_700_000_000_000;
    render(
      <StalenessBanner
        generatedAtMs={gen}
        serverNow={() => gen + (STALENESS_CRITICAL_MS - 1)}
        tickMs={10_000}
      />,
    );
    expect(screen.queryByTestId('staleness-banner')).toBeNull();
  });

  it('renders the red banner exactly at 90_000ms threshold', () => {
    const gen = 1_700_000_000_000;
    render(
      <StalenessBanner
        generatedAtMs={gen}
        serverNow={() => gen + STALENESS_CRITICAL_MS}
        tickMs={10_000}
      />,
    );
    const banner = screen.getByTestId('staleness-banner');
    expect(banner).toHaveTextContent(STALENESS_BANNER_COPY);
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('crosses the threshold on the 1s tick without a prop change', () => {
    const gen = 1_700_000_000_000;
    let fakeServerNow = gen + 89_000; // 1s shy of threshold initially
    render(<StalenessBanner generatedAtMs={gen} serverNow={() => fakeServerNow} tickMs={1_000} />);
    expect(screen.queryByTestId('staleness-banner')).toBeNull();

    // Advance the "server" clock past the threshold and the internal ticker
    // by 1s. The banner must appear on the next re-render triggered by the
    // internal interval — no new props required.
    fakeServerNow = gen + STALENESS_CRITICAL_MS + 500;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('staleness-banner')).toBeInTheDocument();
  });

  it('renders nothing when generated_at_ms is null (pre-first-fetch or old payload)', () => {
    render(
      <StalenessBanner generatedAtMs={null} serverNow={() => 1_700_000_000_000} tickMs={10_000} />,
    );
    expect(screen.queryByTestId('staleness-banner')).toBeNull();
  });
});

describe('StalenessBanner (store-driven, default mount path)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSnapshotStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden after a fresh publishSnapshot (FRESH state)', () => {
    vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
    // Publish a timestamp essentially equal to Date.now().
    publishSnapshot(Date.now(), { isLive: true });
    render(<StalenessBanner tickMs={10_000} />);
    expect(screen.queryByTestId('staleness-banner')).toBeNull();
  });

  it('shows the banner once wall-clock time advances past threshold since last publish', () => {
    vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
    // Publish a "now" snapshot. clockOffset := 0. serverNow() == Date.now().
    publishSnapshot(Date.now(), { isLive: true });
    render(<StalenessBanner tickMs={1_000} />);
    expect(screen.queryByTestId('staleness-banner')).toBeNull();

    // Simulate 2 minutes of wall-clock passing with no new snapshot arriving
    // — the ingest has stalled. The 1s tick recomputes isStale against the
    // frozen generatedAtMs and the now-advanced Date.now().
    act(() => {
      vi.setSystemTime(new Date('2026-04-19T12:02:00Z'));
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('staleness-banner')).toBeInTheDocument();
  });
});
