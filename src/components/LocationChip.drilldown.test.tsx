import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LocationChip from './LocationChip';
import { USER_LOCATION_KEY } from '@/lib/userLocation';

// The drill-down picker reads/writes localStorage via useUserLocation and
// (in the browser) fetches the states GeoJSON. jsdom has no real same-origin
// asset server, so the fetch fails and the chip falls back to region tiles —
// which is exactly the graceful-degradation path we want to lock in. Reset
// storage between tests so each starts from the "All states" default.
afterEach(() => {
  window.localStorage.removeItem(USER_LOCATION_KEY);
  vi.restoreAllMocks();
});

function expand() {
  render(<LocationChip />);
  fireEvent.click(screen.getByRole('button', { name: /location/i }));
}

describe('<LocationChip /> — region drill-down', () => {
  it('shows the seven regions when expanded', async () => {
    expand();
    expect(await screen.findByRole('button', { name: /great lakes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^west/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new england/i })).toBeInTheDocument();
  });

  it('drills from a region into just that region’s states', async () => {
    expand();
    fireEvent.click(await screen.findByRole('button', { name: /great lakes/i }));
    // Wisconsin lives in the Great Lakes region; Texas does not.
    expect(await screen.findByRole('button', { name: /wisconsin/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^texas/i })).not.toBeInTheDocument();
  });

  it('commits the chosen state and collapses', async () => {
    const onChange = vi.fn();
    render(<LocationChip onLocationChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /location/i }));
    fireEvent.click(await screen.findByRole('button', { name: /great lakes/i }));
    fireEvent.click(await screen.findByRole('button', { name: /wisconsin/i }));

    await waitFor(() => {
      const saved = window.localStorage.getItem(USER_LOCATION_KEY);
      expect(saved).toContain('"state":"WI"');
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'WI' }));
  });

  it('returns to the region overview via the back control', async () => {
    expand();
    fireEvent.click(await screen.findByRole('button', { name: /great lakes/i }));
    fireEvent.click(await screen.findByRole('button', { name: /wisconsin/i }));
    // After committing we collapse; re-expand and confirm we land on regions,
    // not the previous state list.
    fireEvent.click(screen.getByRole('button', { name: /location/i }));
    expect(await screen.findByRole('button', { name: /great lakes/i })).toBeInTheDocument();
  });

  it('lets the back button leave a drilled region without picking a state', async () => {
    expand();
    fireEvent.click(await screen.findByRole('button', { name: /great lakes/i }));
    fireEvent.click(await screen.findByRole('button', { name: /regions|back/i }));
    expect(await screen.findByRole('button', { name: /new england/i })).toBeInTheDocument();
  });

  it('short-circuits region selection when searching by name', async () => {
    expand();
    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: 'florida' },
    });
    expect(await screen.findByRole('button', { name: /florida/i })).toBeInTheDocument();
    // Region tiles give way to flat results while searching.
    expect(screen.queryByRole('button', { name: /great lakes/i })).not.toBeInTheDocument();
  });

  it('keeps Alaska, Hawaii and territories reachable from the overview', async () => {
    expand();
    expect(await screen.findByRole('button', { name: /alaska/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hawaii/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /puerto rico/i })).toBeInTheDocument();
  });

  it('pulses the drilled region’s states to prompt a selection, but not search results', async () => {
    expand();
    fireEvent.click(await screen.findByRole('button', { name: /great lakes/i }));
    const wisconsin = await screen.findByRole('button', { name: /wisconsin/i });
    // Drill-down leaf nudges the user to keep going (tap a state to see alerts).
    expect(wisconsin).toHaveClass('ss-pulse');
    // It carries the region accent so the pulse colour ties back to the map.
    expect(wisconsin.style.getPropertyValue('--ss-pulse')).not.toBe('');

    // Searching is a deliberate jump, not a half-finished drill-down — no nag.
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'florida' } });
    const florida = await screen.findByRole('button', { name: /florida/i });
    expect(florida).not.toHaveClass('ss-pulse');
  });
});
