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
});
