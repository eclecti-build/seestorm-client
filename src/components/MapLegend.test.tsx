import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import MapLegend from './MapLegend';
import { WARNING_COLORS, type AlertTier } from '@/lib/alerts';

function renderLegend(
  props: Partial<{
    hiddenTiers: ReadonlySet<AlertTier>;
    onToggleTier: (tier: AlertTier) => void;
    hiddenEvents: ReadonlySet<string>;
    onToggleEvent: (event: string) => void;
    showTornadoCta: boolean;
    onToggleTornadoCta: () => void;
  }> = {},
) {
  const onToggleTier = props.onToggleTier ?? vi.fn();
  const onToggleEvent = props.onToggleEvent ?? vi.fn();
  const onToggleTornadoCta = props.onToggleTornadoCta ?? vi.fn();
  const hiddenTiers = props.hiddenTiers ?? new Set<AlertTier>();
  const hiddenEvents = props.hiddenEvents ?? new Set<string>();
  const showTornadoCta = props.showTornadoCta ?? true;
  const utils = render(
    <MapLegend
      hiddenTiers={hiddenTiers}
      onToggleTier={onToggleTier}
      hiddenEvents={hiddenEvents}
      onToggleEvent={onToggleEvent}
      showTornadoCta={showTornadoCta}
      onToggleTornadoCta={onToggleTornadoCta}
    />,
  );
  return { ...utils, onToggleTier, onToggleEvent, onToggleTornadoCta };
}

// Expand the collapsed legend chip into its full body.
function openLegend() {
  fireEvent.click(screen.getByRole('button', { name: /^legend$/i }));
}

// Per-event visibility now lives behind a collapsed <details> so the open
// legend stays short. Tests that interact with individual event rows must
// summon it first (in jsdom the rows stay mounted regardless, but opening
// the disclosure keeps the test honest about the real interaction).
function openPerEvent() {
  const summary = screen.getByText(/per-event visibility/i).closest('summary');
  if (!summary) throw new Error('Per-event disclosure summary not found');
  // jsdom doesn't toggle <details> on summary click — force the `open`
  // attribute directly, matching the AlertsPanel FamilySection test
  // convention (see AlertsPanel.test.tsx).
  summary.closest('details')?.setAttribute('open', '');
}

describe('<MapLegend />', () => {
  it('renders collapsed by default (body hidden)', () => {
    renderLegend();
    const toggle = screen.getByRole('button', { name: /^legend$/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // None of the event rows should be rendered while collapsed.
    expect(screen.queryByText('Tornado Warning')).not.toBeInTheDocument();
  });

  it('lists every event in the palette under the Per-event disclosure', () => {
    renderLegend();
    openLegend();
    openPerEvent();

    for (const event of Object.keys(WARNING_COLORS)) {
      expect(screen.getByText(event)).toBeInTheDocument();
    }
  });

  it('keeps the per-event list collapsed behind a disclosure by default', () => {
    const { container } = renderLegend();
    openLegend();

    // Tier toggles are the always-visible primary control.
    expect(screen.getByRole('button', { name: /toggle warning alerts on map/i })).toBeVisible();

    // The finer per-event list is gated behind a <details> that is closed
    // by default, so the open legend stays short (the heavy-stack
    // regression fix). The row is mounted but not visible (jest-dom treats
    // a closed-<details> descendant as hidden).
    const details = container.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    const row = screen.getByRole('button', { name: /toggle tornado warning on map/i });
    expect(row).toBeInTheDocument();
    expect(row).not.toBeVisible();
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

  it('shows the tier key, tornado-status key, and storm-motion explainer when expanded', () => {
    renderLegend();
    openLegend();
    expect(screen.getByText(/warning — take action/i)).toBeInTheDocument();
    expect(screen.getByText(/watch — be aware/i)).toBeInTheDocument();
    expect(screen.getByText(/advisory — monitor/i)).toBeInTheDocument();
    expect(screen.getByText(/tornado status/i)).toBeInTheDocument();
    expect(screen.getByText(/radar indicated/i)).toBeInTheDocument();
    expect(screen.getByText(/tornado not confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/particularly dangerous/i)).toBeInTheDocument();
    expect(screen.getByText(/confirmed strong tornado/i)).toBeInTheDocument();
    // Storm-motion copy is deliberately framed as an estimate, not an
    // NWS forecast (it's a straight-line dead-reckoning projection).
    expect(screen.getByText(/estimated track if the storm holds/i)).toBeInTheDocument();
    expect(screen.getByText(/not an NWS\s+forecast/i)).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /not an NWS forecast or predicted track/i }),
    ).toBeInTheDocument();
  });

  describe('on-map alert-text toggle', () => {
    it('defaults to on (aria-pressed=true) and reads "on"', () => {
      renderLegend({ showTornadoCta: true });
      openLegend();
      const toggle = screen.getByRole('button', { name: /toggle on-map tornado alert text/i });
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      expect(within(toggle).getByText('on')).toBeInTheDocument();
    });

    it('reflects the off state via aria-pressed when showTornadoCta is false', () => {
      renderLegend({ showTornadoCta: false });
      openLegend();
      const toggle = screen.getByRole('button', { name: /toggle on-map tornado alert text/i });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      expect(within(toggle).getByText('off')).toBeInTheDocument();
    });

    it('invokes onToggleTornadoCta when clicked', () => {
      const { onToggleTornadoCta } = renderLegend();
      openLegend();
      fireEvent.click(screen.getByRole('button', { name: /toggle on-map tornado alert text/i }));
      expect(onToggleTornadoCta).toHaveBeenCalledTimes(1);
    });
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
    openLegend();
    openPerEvent();

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
    openLegend();
    openPerEvent();

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
    openLegend();
    openPerEvent();

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
    openLegend();
    openPerEvent();

    const row = screen.getByRole('button', { name: /toggle tornado warning on map/i });
    expect(row.className).toMatch(/opacity-40/);
  });

  // Icon-presence regression (2026-04-19): the legend event rows should carry
  // an event-type icon alongside the color swatch. We assert presence via
  // data-testid rather than shape-snapshotting the SVG — snapshots rot and
  // don't catch the actual contract (one icon per row).
  describe('event-type icons', () => {
    it('renders an icon for every event row when expanded', () => {
      renderLegend();
      openLegend();
      openPerEvent();

      for (const event of Object.keys(WARNING_COLORS)) {
        expect(screen.getByTestId(`map-legend-icon-${event}`)).toBeInTheDocument();
      }
    });

    it('does not render icons while collapsed', () => {
      renderLegend();
      expect(screen.queryByTestId('map-legend-icon-Tornado Warning')).not.toBeInTheDocument();
    });
  });

  // Placement + width regression: the legend flows INLINE as the last
  // child of the top-left column (below the location selector), so it
  // must NOT self-position. It also must not carry the fixed-height
  // flex-column / nested-scroll classes from the old heavy stacked
  // layout. Collapsed hugs text so it doesn't eat mobile width; expanded
  // grows to a fixed reading width and the body caps its own height +
  // scrolls so a long open legend can't run off a short screen.
  describe('placement + width states (mobile viewport regression)', () => {
    it('collapsed legend hugs content (w-fit)', () => {
      renderLegend();
      const region = screen.getByRole('region', { name: /map legend/i });
      expect(region).toHaveClass('w-fit');
      expect(region).not.toHaveClass('w-72');
    });

    it('flows inline (no self-positioning), not stacked in a fixed-height clipped column', () => {
      const { container } = renderLegend();
      openLegend();
      const region = screen.getByRole('region', { name: /map legend/i });
      expect(region).toHaveClass('w-72');
      expect(region).not.toHaveClass('w-fit');
      // It flows in the parent column — it must NOT self-position, or it
      // would detach from the location chip it's meant to sit under.
      expect(region).not.toHaveClass('absolute', 'fixed');
      expect(region.className).not.toMatch(/(^|\s)(bottom|top|left|right)-\[/);
      // The fixed-height flex-column / nested-scroll classes from the old
      // heavy stacked layout must be absent — that's the heaviness we undid.
      expect(region).not.toHaveClass('max-h-full', 'min-h-0', 'shrink', 'flex', 'flex-col');
      // Body still caps its own height and scrolls internally so a long
      // open legend can't push the column off a short screen.
      const body = container.querySelector('#map-legend-body');
      expect(body).toHaveClass('ss-legend-maxh', 'overflow-y-auto', 'overscroll-contain');
      expect(body).not.toHaveClass('min-h-0');
    });
  });
});
