import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AlertsPanel from './AlertsPanel';
import { ingestToWeatherAlert, type IngestAlert, type WeatherAlert } from '@/lib/alerts';

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
});
