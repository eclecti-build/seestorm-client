import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AlertsPanel from './AlertsPanel';
import { ingestToWeatherAlert, type IngestAlert, type WeatherAlert } from '@/lib/alerts';
import { __resetSnapshotStoreForTests, publishLiveFetchFailure } from '@/lib/snapshotStore';
import { FETCH_DEGRADED_THRESHOLD } from '@/lib/constants';

const STUB_GEOMETRY: GeoJSON.Geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-89.5, 42.5],
      [-89.4, 42.5],
      [-89.4, 42.6],
      [-89.5, 42.6],
      [-89.5, 42.5],
    ],
  ],
};

// FIXED_NOW is injected so "in Xm" strings are deterministic in tests.
const FIXED_NOW = Date.parse('2026-04-17T20:00:00Z');

function build(
  ingest: Partial<IngestAlert> & Pick<IngestAlert, 'event_type' | 'nws_id'>,
): WeatherAlert {
  return ingestToWeatherAlert({
    severity: 'Severe',
    headline: `${ingest.event_type} headline`,
    description: 'desc',
    area_desc: `${ingest.nws_id} area`,
    geometry: STUB_GEOMETRY,
    effective_at: '2026-04-17T19:30:00Z',
    expires_at: '2026-04-17T20:30:00Z', // 30 min from FIXED_NOW
    ...ingest,
  });
}

describe('<AlertsPanel />', () => {
  it('renders an empty state when there are zero alerts', () => {
    render(<AlertsPanel alerts={[]} onSelect={() => {}} now={FIXED_NOW} />);
    expect(screen.getByText(/no active alerts/i)).toBeInTheDocument();
  });

  it('groups alerts by family and orders Tornado first', () => {
    const alerts: WeatherAlert[] = [
      build({ nws_id: 'FF', event_type: 'Flash Flood Warning' }),
      build({ nws_id: 'STW', event_type: 'Severe Thunderstorm Warning' }),
      build({ nws_id: 'TO', event_type: 'Tornado Warning' }),
      build({ nws_id: 'SWS', event_type: 'Special Weather Statement' }),
    ];
    render(<AlertsPanel alerts={alerts} onSelect={() => {}} now={FIXED_NOW} />);

    const sections = screen.getAllByRole('group');
    // details elements render as role="group" — order must be Tornado first,
    // then Severe Thunderstorm, Flash Flood, Other.
    expect(sections[0]).toHaveTextContent(/^Tornado/);
    expect(sections[1]).toHaveTextContent(/^Severe Thunderstorm/);
    expect(sections[2]).toHaveTextContent(/^Flash Flood/);
    expect(sections[3]).toHaveTextContent(/^Other/);
  });

  it('opens the Tornado family by default; other families stay collapsed', () => {
    const alerts: WeatherAlert[] = [
      build({ nws_id: 'TO', event_type: 'Tornado Warning' }),
      build({ nws_id: 'STW', event_type: 'Severe Thunderstorm Warning' }),
    ];
    const { container } = render(
      <AlertsPanel alerts={alerts} onSelect={() => {}} now={FIXED_NOW} />,
    );
    const detailsEls = container.querySelectorAll('details');
    expect(detailsEls[0]).toHaveAttribute('open'); // Tornado
    expect(detailsEls[1]).not.toHaveAttribute('open'); // Severe Thunderstorm
  });

  it('fires onSelect with the full alert when a card body is clicked', () => {
    const onSelect = vi.fn();
    const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
    render(<AlertsPanel alerts={[tornado]} onSelect={onSelect} now={FIXED_NOW} />);

    const card = screen.getByRole('button', { name: /tornado warning/i });
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(tornado);
  });

  it('renders an external link with target=_blank + rel=noopener,noreferrer', () => {
    const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
    render(<AlertsPanel alerts={[tornado]} onSelect={() => {}} now={FIXED_NOW} />);

    const link = screen.getByRole('link', { name: /weather\.gov/i });
    expect(link).toHaveAttribute('href', 'https://api.weather.gov/alerts/TO.1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('prefers an ingest-provided url over the fallback', () => {
    const tornado = build({
      nws_id: 'TO.1',
      event_type: 'Tornado Warning',
      url: 'https://nws.example/alert/abc',
    });
    render(<AlertsPanel alerts={[tornado]} onSelect={() => {}} now={FIXED_NOW} />);
    const link = screen.getByRole('link', { name: /weather\.gov/i });
    expect(link).toHaveAttribute('href', 'https://nws.example/alert/abc');
  });

  it('clicking the link does not also fire the card onSelect', () => {
    const onSelect = vi.fn();
    const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
    render(<AlertsPanel alerts={[tornado]} onSelect={onSelect} now={FIXED_NOW} />);

    const link = screen.getByRole('link', { name: /weather\.gov/i });
    fireEvent.click(link);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides the link when both url and nwsId are missing', () => {
    // Direct-construct a WeatherAlert with no url and no nwsId — simulates an
    // alert from a snapshot that lacks both.
    const bare: WeatherAlert = {
      type: 'Feature',
      properties: {
        event: 'Tornado Warning',
        headline: 'x',
        description: 'x',
        severity: 'Extreme',
        urgency: '',
        effective: '2026-04-17T19:30:00Z',
        expires: '2026-04-17T20:30:00Z',
        senderName: '',
        areaDesc: 'Dane, WI',
        url: null,
        nwsId: null,
      },
      geometry: STUB_GEOMETRY,
    };
    render(<AlertsPanel alerts={[bare]} onSelect={() => {}} now={FIXED_NOW} />);
    expect(screen.queryByRole('link', { name: /weather\.gov/i })).not.toBeInTheDocument();
  });

  it('marks the currently selected card with aria-pressed=true', () => {
    const a = build({ nws_id: 'A', event_type: 'Tornado Warning' });
    const b = build({ nws_id: 'B', event_type: 'Tornado Warning' });
    render(<AlertsPanel alerts={[a, b]} onSelect={() => {}} now={FIXED_NOW} selectedId="B" />);

    const buttons = screen.getAllByRole('button', { name: /tornado warning/i });
    // order within family is priority-stable from parent; both are the same
    // event, so rely on the aria-pressed signal instead of positional index.
    const pressed = buttons.filter((el) => el.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(within(pressed[0]).getByText(/B area/)).toBeInTheDocument();
  });

  it('renders relative expiry based on the injected now', () => {
    const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
    render(<AlertsPanel alerts={[tornado]} onSelect={() => {}} now={FIXED_NOW} />);
    // expires_at is 30m after FIXED_NOW.
    expect(screen.getByText(/expires in 30m/i)).toBeInTheDocument();
  });

  it('collapses and re-expands the whole panel via the header toggle', () => {
    const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
    render(<AlertsPanel alerts={[tornado]} onSelect={() => {}} now={FIXED_NOW} />);

    // Expanded by default — family section visible.
    expect(screen.getByRole('group')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /collapse alerts panel/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);

    // After collapse: family section gone, header button flipped state.
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    const expandToggle = screen.getByRole('button', { name: /expand alerts panel/i });
    expect(expandToggle).toHaveAttribute('aria-expanded', 'false');

    // Re-expand restores the groups.
    fireEvent.click(expandToggle);
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  it('keeps the empty-state rendering unchanged (no collapse toggle when there are no alerts)', () => {
    render(<AlertsPanel alerts={[]} onSelect={() => {}} now={FIXED_NOW} />);
    expect(
      screen.queryByRole('button', { name: /collapse alerts panel/i }),
    ).not.toBeInTheDocument();
  });

  // Icon-presence regression (2026-04-19): alert cards and family headers
  // should carry event-type icons. Asserting by data-testid keeps the test
  // resilient to SVG-shape changes — we care that the icon is THERE and
  // labeled with the right event, not what strokes it draws.
  describe('event-type icons', () => {
    it('renders an icon on every alert card', () => {
      const alerts: WeatherAlert[] = [
        build({ nws_id: 'TO', event_type: 'Tornado Warning' }),
        build({ nws_id: 'STW', event_type: 'Severe Thunderstorm Warning' }),
        build({ nws_id: 'FF', event_type: 'Flash Flood Warning' }),
      ];
      // Need to force-open every family to see their cards (defaults only
      // open Tornado). Easiest: render, click each summary to open.
      const { container } = render(
        <AlertsPanel alerts={alerts} onSelect={() => {}} now={FIXED_NOW} />,
      );
      container.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));

      expect(screen.getByTestId('alert-card-icon-Tornado Warning')).toBeInTheDocument();
      expect(screen.getByTestId('alert-card-icon-Severe Thunderstorm Warning')).toBeInTheDocument();
      expect(screen.getByTestId('alert-card-icon-Flash Flood Warning')).toBeInTheDocument();
    });

    it('renders an icon on every family header', () => {
      const alerts: WeatherAlert[] = [
        build({ nws_id: 'TO', event_type: 'Tornado Warning' }),
        build({ nws_id: 'STW', event_type: 'Severe Thunderstorm Warning' }),
        build({ nws_id: 'FF', event_type: 'Flash Flood Warning' }),
        build({ nws_id: 'SWS', event_type: 'Special Weather Statement' }),
      ];
      render(<AlertsPanel alerts={alerts} onSelect={() => {}} now={FIXED_NOW} />);

      expect(screen.getByTestId('alerts-family-icon-Tornado')).toBeInTheDocument();
      expect(screen.getByTestId('alerts-family-icon-Severe Thunderstorm')).toBeInTheDocument();
      expect(screen.getByTestId('alerts-family-icon-Flash Flood')).toBeInTheDocument();
      expect(screen.getByTestId('alerts-family-icon-Other')).toBeInTheDocument();
    });
  });

  // Width-toggle regression (codex 2026-04-18): the panel must hug its text
  // when collapsed and only expand to a fixed width when opened. Without
  // this guarantee the mobile viewport fix silently regresses — the old
  // `w-80` parent column used to force all three stacked panels to 320px
  // even when collapsed.
  describe('width states (mobile viewport regression)', () => {
    it('empty state hugs content (w-fit)', () => {
      render(<AlertsPanel alerts={[]} onSelect={() => {}} now={FIXED_NOW} />);
      const region = screen.getByRole('region', { name: /active alerts/i });
      expect(region).toHaveClass('w-fit');
      expect(region).not.toHaveClass('w-80');
    });

    it('expanded panel uses a fixed w-80 width', () => {
      const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
      render(<AlertsPanel alerts={[tornado]} onSelect={() => {}} now={FIXED_NOW} />);
      const region = screen.getByRole('region', { name: /active alerts/i });
      expect(region).toHaveClass('w-80');
      expect(region).not.toHaveClass('w-fit');
    });

    it('collapsed panel hugs content (w-fit) and drops the expanded width', () => {
      const tornado = build({ nws_id: 'TO.1', event_type: 'Tornado Warning' });
      render(<AlertsPanel alerts={[tornado]} onSelect={() => {}} now={FIXED_NOW} />);

      fireEvent.click(screen.getByRole('button', { name: /collapse alerts panel/i }));

      const region = screen.getByRole('region', { name: /active alerts/i });
      expect(region).toHaveClass('w-fit');
      expect(region).not.toHaveClass('w-80');
    });
  });

  // Multi-state NWS products (Freeze Warnings covering IN+MI+OH, tri-state
  // Frost Advisories, river Flood Warnings spanning IN+MI) legitimately
  // touch the user's state but list cross-border counties in `areaDesc`.
  // The card trims the rendered list to just the user's state and badges
  // the alert as regional so the broader scope stays visible.
  describe('multi-state alert display (userState filtering)', () => {
    it('filters areaDesc by state suffix and renders a regional badge referencing other states', () => {
      const multi = build({
        nws_id: 'FREEZE.1',
        event_type: 'Freeze Warning',
        area_desc: 'Elkhart, IN; Branch, MI; St. Joseph, MI',
        states: ['IN', 'MI'],
      });
      render(<AlertsPanel alerts={[multi]} onSelect={() => {}} now={FIXED_NOW} userState="IN" />);

      // Only the Indiana county is rendered in the area list.
      expect(screen.getByText('Elkhart, IN')).toBeInTheDocument();
      expect(screen.queryByText(/Branch, MI/)).not.toBeInTheDocument();
      expect(screen.queryByText(/St\. Joseph, MI/)).not.toBeInTheDocument();

      // Badge names the user's state and pluralizes "other state" for N=1.
      expect(screen.getByText(/Regional — covers IN \+ 1 other state/)).toBeInTheDocument();
    });

    it('omits the regional badge for single-state alerts', () => {
      const single = build({
        nws_id: 'TO.1',
        event_type: 'Tornado Warning',
        area_desc: 'Elkhart, IN',
        states: ['IN'],
      });
      render(<AlertsPanel alerts={[single]} onSelect={() => {}} now={FIXED_NOW} userState="IN" />);

      expect(screen.queryByText(/Regional/)).not.toBeInTheDocument();
    });

    it('renders the full areaDesc unfiltered when userState is undefined', () => {
      const multi = build({
        nws_id: 'FREEZE.1',
        event_type: 'Freeze Warning',
        area_desc: 'Elkhart, IN; Branch, MI; St. Joseph, MI',
        states: ['IN', 'MI'],
      });
      render(<AlertsPanel alerts={[multi]} onSelect={() => {}} now={FIXED_NOW} />);

      expect(screen.getByText('Elkhart, IN; Branch, MI; St. Joseph, MI')).toBeInTheDocument();
    });
  });
});

describe('<AlertsPanel /> — fetch-health degraded notice', () => {
  beforeEach(() => {
    __resetSnapshotStoreForTests();
  });

  it('shows "No active alerts." for a confirmed-empty list (no fetch failures)', () => {
    render(<AlertsPanel alerts={[]} onSelect={() => {}} now={FIXED_NOW} />);
    expect(screen.getByText('No active alerts.')).toBeInTheDocument();
  });

  it('does not show the degraded notice below FETCH_DEGRADED_THRESHOLD', () => {
    for (let i = 0; i < FETCH_DEGRADED_THRESHOLD - 1; i++) publishLiveFetchFailure();
    render(<AlertsPanel alerts={[]} onSelect={() => {}} now={FIXED_NOW} />);
    expect(screen.getByText('No active alerts.')).toBeInTheDocument();
  });

  it('shows "Alert data unavailable" once consecutive failures reach FETCH_DEGRADED_THRESHOLD, including a never-yet-succeeded session', () => {
    for (let i = 0; i < FETCH_DEGRADED_THRESHOLD; i++) publishLiveFetchFailure();
    render(<AlertsPanel alerts={[]} onSelect={() => {}} now={FIXED_NOW} />);
    expect(screen.getByText(/alert data unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('No active alerts.')).toBeNull();
  });
});
