import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LocationChip from './LocationChip';
import { USER_LOCATION_KEY } from '@/lib/userLocation';

// LocationChip reads/writes localStorage via useUserLocation. jsdom provides
// a real localStorage, so reset it between tests to keep the chip in its
// "no saved location" default.
afterEach(() => {
  window.localStorage.removeItem(USER_LOCATION_KEY);
});

describe('<LocationChip /> — width states (mobile viewport regression)', () => {
  // Codex 2026-04-18: the stacked panel column (AlertsPanel → LocationChip
  // → MapLegend) dropped its parent `w-80` cap so collapsed chips hug text
  // and only the expanded one grows. These tests lock in the per-chip
  // toggle so a future refactor can't silently re-force every chip to the
  // widest sibling.

  it('collapsed chip hugs content (w-fit)', () => {
    render(<LocationChip />);
    const region = screen.getByRole('region', { name: /location filter/i });
    expect(region).toHaveClass('w-fit');
    expect(region).not.toHaveClass('w-72');
  });

  it('expanded chip uses a fixed w-72 width', () => {
    render(<LocationChip />);
    // Header button toggles the expanded body (state grid + ZIP form).
    fireEvent.click(screen.getByRole('button', { name: /location/i }));
    const region = screen.getByRole('region', { name: /location filter/i });
    expect(region).toHaveClass('w-72');
    expect(region).not.toHaveClass('w-fit');
  });

  it('re-collapsing returns the chip to w-fit', () => {
    render(<LocationChip />);
    const header = screen.getByRole('button', { name: /location/i });
    fireEvent.click(header); // expand
    fireEvent.click(header); // collapse again
    const region = screen.getByRole('region', { name: /location filter/i });
    expect(region).toHaveClass('w-fit');
    expect(region).not.toHaveClass('w-72');
  });
});
