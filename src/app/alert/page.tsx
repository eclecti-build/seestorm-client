'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  colorForEvent,
  tierForEvent,
  parseIngestSnapshot,
  type WeatherAlert,
  buildAlertViews,
} from '@/lib/alerts';

type AlertDetailState =
  | { status: 'loading' }
  | { status: 'found'; alert: WeatherAlert }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

function parseAlertIdFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  const prefix = '/alert/';
  const path = window.location.pathname;
  if (path.startsWith(prefix) && path.length > prefix.length) {
    return decodeURIComponent(path.slice(prefix.length));
  }
  return null;
}

export default function AlertDetailPage() {
  const [alertId] = useState(parseAlertIdFromPath);
  const [state, setState] = useState<AlertDetailState>({ status: 'loading' });

  useEffect(() => {
    if (!alertId) {
      // Wrap in a microtask so the setState is not synchronous within the effect body.
      Promise.resolve().then(() => setState({ status: 'not-found' }));
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/v1/active-events.json', {
          signal: controller.signal,
        });
        if (!res.ok) {
          setState({ status: 'error', message: `Failed to fetch alerts (${res.status})` });
          return;
        }
        const raw = await res.json();
        const snapshot = parseIngestSnapshot(raw);
        const { listAlerts } = buildAlertViews(snapshot);
        const match = listAlerts.find((a) => a.properties.nwsId === alertId);
        setState(match ? { status: 'found', alert: match } : { status: 'not-found' });
      } catch (err) {
        if (!controller.signal.aborted) {
          setState({ status: 'error', message: String(err) });
        }
      }
    })();

    return () => controller.abort();
  }, [alertId]);

  return (
    <div className="ss-viewport-fill w-full overflow-y-auto bg-[var(--ss-bg)] text-[var(--ss-ink)]">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Link
          href="/"
          className="mb-10 inline-flex items-center gap-2 text-sm text-[var(--ss-muted)] transition hover:text-[var(--ss-ink)]"
          aria-label="Back to map"
        >
          <span aria-hidden="true">←</span> Back to map
        </Link>

        {state.status === 'loading' && (
          <div className="text-[var(--ss-muted)]">Loading alert...</div>
        )}

        {state.status === 'error' && (
          <div>
            <h1 className="text-2xl font-semibold mb-4">Error</h1>
            <p className="text-[var(--ss-muted)]">{state.message}</p>
          </div>
        )}

        {state.status === 'not-found' && (
          <div>
            <h1 className="text-2xl font-semibold mb-4">Alert not found</h1>
            <p className="text-[var(--ss-muted)]">
              This alert has expired or is no longer active. Active alerts are only available while
              the NWS has them in effect.
            </p>
            <Link
              href="/"
              className="mt-6 inline-block text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              View current alerts on the map
            </Link>
          </div>
        )}

        {state.status === 'found' && <AlertDetail alert={state.alert} />}
      </div>
    </div>
  );
}

function AlertDetail({ alert }: { alert: WeatherAlert }) {
  const { event, headline, description, severity, areaDesc, effective, expires } = alert.properties;
  const color = alert.properties.tornadoColor ?? colorForEvent(event);
  const tier = tierForEvent(event);
  const tornado = alert.properties.tornado;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span
          className="inline-block w-3 h-3 rounded-sm shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color }}>
          {alert.properties.tornadoLabel ?? event}
        </span>
        <span className="text-xs text-[var(--ss-muted)]">{tier}</span>
      </div>

      {alert.properties.tornadoAnnotation && (
        <div
          className="mb-4 rounded-md px-3 py-2 text-sm font-semibold"
          style={{ backgroundColor: `${color}22`, color }}
        >
          {alert.properties.tornadoAnnotation}
        </div>
      )}

      <h1 className="text-xl font-semibold mb-4">{headline}</h1>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mb-6">
        <dt className="text-[var(--ss-muted)]">Severity</dt>
        <dd>{severity}</dd>
        <dt className="text-[var(--ss-muted)]">Area</dt>
        <dd>{areaDesc}</dd>
        <dt className="text-[var(--ss-muted)]">Effective</dt>
        <dd>{new Date(effective).toLocaleString()}</dd>
        <dt className="text-[var(--ss-muted)]">Expires</dt>
        <dd>{new Date(expires).toLocaleString()}</dd>
        {alert.properties.states && alert.properties.states.length > 0 && (
          <>
            <dt className="text-[var(--ss-muted)]">States</dt>
            <dd>{alert.properties.states.join(', ')}</dd>
          </>
        )}
        {tornado && (
          <>
            <dt className="text-[var(--ss-muted)]">Detection</dt>
            <dd>
              {tornado.confirmed ? 'Observed / Confirmed' : 'Radar Indicated'}
              {tornado.damage_threat !== 'BASE' &&
                ` — ${tornado.damage_threat.charAt(0)}${tornado.damage_threat.slice(1).toLowerCase()} damage threat`}
            </dd>
            {tornado.source_text && (
              <>
                <dt className="text-[var(--ss-muted)]">Source</dt>
                <dd>{tornado.source_text}</dd>
              </>
            )}
          </>
        )}
        {alert.properties.nwsId && (
          <>
            <dt className="text-[var(--ss-muted)]">NWS ID</dt>
            <dd className="font-mono text-xs">{alert.properties.nwsId}</dd>
          </>
        )}
      </dl>

      <section className="mb-8">
        <h2 className="text-base font-semibold mb-2">Description</h2>
        <p className="text-sm whitespace-pre-line text-[var(--ss-ink)] leading-relaxed">
          {description}
        </p>
      </section>

      <Link
        href={`/?focus=${encodeURIComponent(alert.properties.nwsId ?? '')}`}
        className="inline-flex items-center gap-2 text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)] text-sm"
      >
        View on map <span aria-hidden="true">→</span>
      </Link>

      {alert.properties.nwsId && (
        <div className="mt-8 pt-4 border-t border-[var(--ss-border)] text-xs text-[var(--ss-muted)] space-y-2">
          <p>
            Data provided by the{' '}
            <a
              href="https://www.weather.gov"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)] underline underline-offset-2"
            >
              National Weather Service
            </a>{' '}
            via the{' '}
            <a
              href="https://www.weather.gov/documentation/services-web-api"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)] underline underline-offset-2"
            >
              NWS API
            </a>
            . The NWS API provides real-time access to alerts, forecasts, and observations from
            National Weather Service offices across the United States. All NWS data is in the public
            domain.
          </p>
          <p>
            <a
              href={`https://api.weather.gov/alerts/${encodeURIComponent(alert.properties.nwsId)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)] underline underline-offset-2"
            >
              View raw NWS API response for this alert →
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
