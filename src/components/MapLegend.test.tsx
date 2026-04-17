import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MapLegend from './MapLegend';
import { WARNING_COLORS, type AlertTier } from '@/lib/alerts';

function renderLegend(
  props: Partial<{
    hiddenTiers: ReadonlySet<AlertTier>;
    onToggleTier: (tier: AlertTier) => void;
    hiddenEvents: ReadonlySet<string>;
    onToggleEvent: (event: string) => void;
  }> = {},
) {
  const onToggleTier = props.onToggleTier ?? vi.fn();
  const onToggleEvent = props.onToggleEvent ?? vi.fn();
  const hiddenTiers = props.hiddenTiers ?? new Set<AlertTier>();
  const hiddenEvents = props.hiddenEvents ?? new Set<string>();
  const utils = render(
    <MapLegend
      hiddenTiers={hiddenTiers}
      onToggleTier={onToggleTier}
      hiddenEvents={hiddenEvents}
      onToggleEvent={onToggleEvent}
    />,
  );
  return { ...utils, onToggleTier, onToggleEvent };
}

describe('<MapLegend />', () => {
  it('renders collapsed by default (body hidden)', () => {
    renderLegend();
    const toggle = screen.getByRole('button', { name: /^legend$/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // None of the event rows should be rendered while collapsed.
    expect(screen.queryByText('Tornado Warning')).not.toBeInTheDocument();
  });

  it('expands on click and lists every event in the palette', () => {
    renderLegend();
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    for (const event of Object.keys(WARNING_COLORS)) {
      expect(screen.getByText(event)).toBeInTheDocument();
    }
  });

  it('collapses again on a second click', () => {
    renderLegend();
    const toggle = screen.getByRole('button', { name: /^legend$/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Tornado Warning')).not.toBeInTheDocument();
  });

  it('shows the tier key and storm-motion explainer when expanded', () => {
    renderLegend();
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));
    expect(screen.getByText(/warning — take action/i)).toBeInTheDocument();
    expect(screen.getByText(/watch — be aware/i)).toBeInTheDocument();
    expect(screen.getByText(/advisory — monitor/i)).toBeInTheDocument();
    expect(screen.getByText(/projected path/i)).toBeInTheDocument();
  });

  it('tier rows are toggle buttons that report current state via aria-pressed', () => {
    const hiddenTiers = new Set<AlertTier>(['Watch']);
    renderLegend({ hiddenTiers });
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    // Labels stay stable across press state (WAI-ARIA APG toggle-button
    // pattern) — screen readers see one control, not a new one per press.
    const warningToggle = screen.getByRole('button', { name: /toggle warning alerts on map/i });
    const watchToggle = screen.getByRole('button', { name: /toggle watch alerts on map/i });
    const advisoryToggle = screen.getByRole('button', { name: /toggle advisory alerts on map/i });

    // Visible tiers report pressed=true (button is "on"); hidden tiers report pressed=false.
    expect(warningToggle).toHaveAttribute('aria-pressed', 'true');
    expect(watchToggle).toHaveAttribute('aria-pressed', 'false');
    expect(advisoryToggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('invokes onToggleTier with the clicked tier', () => {
    const { onToggleTier } = renderLegend();
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    fireEvent.click(screen.getByRole('button', { name: /toggle watch alerts on map/i }));
    expect(onToggleTier).toHaveBeenCalledWith('Watch');

    fireEvent.click(screen.getByRole('button', { name: /toggle warning alerts on map/i }));
    expect(onToggleTier).toHaveBeenCalledWith('Warning');

    expect(onToggleTier).toHaveBeenCalledTimes(2);
  });

  it('dims the matching event rows when a tier is hidden', () => {
    const hiddenTiers = new Set<AlertTier>(['Warning']);
    renderLegend({ hiddenTiers });
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    // Dim styling lives on the row's toggle button (the whole row is a
    // button after the per-event toggle rework).
    const row = screen.getByRole('button', { name: /toggle tornado warning on map/i });
    expect(row.className).toMatch(/opacity-40/);

    // A Watch-tier row stays at full opacity.
    const watchRow = screen.getByRole('button', { name: /toggle tornado watch on map/i });
    expect(watchRow.className).toMatch(/opacity-100/);
  });

  it('each event row is a toggle button that reports its own visibility via aria-pressed', () => {
    const hiddenEvents = new Set<string>(['Severe Thunderstorm Watch']);
    renderLegend({ hiddenEvents });
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    const hiddenRow = screen.getByRole('button', {
      name: /toggle severe thunderstorm watch on map/i,
    });
    const visibleRow = screen.getByRole('button', { name: /toggle tornado warning on map/i });

    // aria-pressed reflects event-level visibility only, not tier visibility —
    // matches the button the user just clicked, so screen readers announce
    // the toggle they actually touched.
    expect(hiddenRow).toHaveAttribute('aria-pressed', 'false');
    expect(visibleRow).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking an event row invokes onToggleEvent with that event name', () => {
    const { onToggleEvent } = renderLegend();
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    fireEvent.click(screen.getByRole('button', { name: /toggle tornado warning on map/i }));
    fireEvent.click(screen.getByRole('button', { name: /toggle flash flood watch on map/i }));

    expect(onToggleEvent).toHaveBeenNthCalledWith(1, 'Tornado Warning');
    expect(onToggleEvent).toHaveBeenNthCalledWith(2, 'Flash Flood Watch');
  });

  it('a hidden event dims its row even when the tier is visible', () => {
    // Independent dimensions: event-level hide should visually mark the row
    // even if the containing tier is still on. Catches a regression where
    // the dim class depended solely on tier state.
    const hiddenEvents = new Set<string>(['Tornado Warning']);
    renderLegend({ hiddenEvents });
    fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));

    const row = screen.getByRole('button', { name: /toggle tornado warning on map/i });
    expect(row.className).toMatch(/opacity-40/);
  });
});
