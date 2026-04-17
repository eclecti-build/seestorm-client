'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  colorForEvent,
  groupByFamily,
  tierForEvent,
  type AlertFamily,
  type WeatherAlert,
} from '@/lib/alerts';

// Tornado-family alerts are life-threatening — they should be visible
// without the user having to click. Everything else starts collapsed so the
// panel stays scannable during a multi-product outbreak.
const DEFAULT_OPEN_FAMILIES: ReadonlySet<AlertFamily> = new Set(['Tornado']);

function RelativeExpiry({ iso, now }: { iso: string; now: number }) {
  const expiresAt = new Date(iso).getTime();
  if (Number.isNaN(expiresAt)) return null;

  const diffMin = Math.round((expiresAt - now) / 60_000);
  let label: string;
  if (diffMin <= 0) label = 'expired';
  else if (diffMin < 60) label = `in ${diffMin}m`;
  else label = `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;

  return (
    <span className="text-gray-400" title={new Date(iso).toLocaleString()}>
      Expires {label}
    </span>
  );
}

function AlertCard({
  alert,
  selected,
  onSelect,
  now,
}: {
  alert: WeatherAlert;
  selected: boolean;
  onSelect: (a: WeatherAlert) => void;
  now: number;
}) {
  const color = colorForEvent(alert.properties.event);
  const tier = tierForEvent(alert.properties.event);
  const url = alert.properties.url;

  return (
    <button
      type="button"
      onClick={() => onSelect(alert)}
      aria-pressed={selected}
      className={`w-full text-left p-2 rounded border transition-colors ${
        selected
          ? 'bg-gray-700 border-white/40'
          : 'bg-gray-800/80 border-gray-700 hover:bg-gray-800'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          aria-hidden="true"
          className="inline-block w-2.5 h-2.5 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
          {alert.properties.event}
        </span>
        <span className="ml-auto text-[10px] text-gray-400">{tier}</span>
      </div>
      <div className="text-xs text-gray-100 line-clamp-2">{alert.properties.areaDesc}</div>
      <div className="flex items-center justify-between mt-1 text-[11px]">
        <RelativeExpiry iso={alert.properties.expires} now={now} />
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sky-300 hover:text-sky-200 underline underline-offset-2"
          >
            weather.gov ↗
          </a>
        )}
      </div>
    </button>
  );
}

function FamilySection({
  family,
  alerts,
  selectedId,
  onSelect,
  now,
}: {
  family: AlertFamily;
  alerts: WeatherAlert[];
  selectedId: string | null;
  onSelect: (a: WeatherAlert) => void;
  now: number;
}) {
  const color = colorForEvent(alerts[0]?.properties.event ?? '');
  return (
    <details
      className="bg-gray-900/80 rounded-md border border-gray-700"
      open={DEFAULT_OPEN_FAMILIES.has(family) || undefined}
    >
      <summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-2 text-sm font-semibold">
        <span
          aria-hidden="true"
          className="inline-block w-1 h-4 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span>{family}</span>
        <span className="ml-auto text-xs text-gray-400">
          {alerts.length} alert{alerts.length !== 1 ? 's' : ''}
        </span>
      </summary>
      <div className="p-2 pt-0 space-y-1.5">
        {alerts.map((a, i) => {
          const key = a.properties.nwsId ?? `${family}-${i}`;
          const selected = selectedId !== null && a.properties.nwsId === selectedId;
          return (
            <AlertCard key={key} alert={a} selected={selected} onSelect={onSelect} now={now} />
          );
        })}
      </div>
    </details>
  );
}

export interface AlertsPanelProps {
  alerts: readonly WeatherAlert[];
  onSelect: (alert: WeatherAlert) => void;
  selectedId?: string | null;
  /** Injectable "now" for stable relative-expiry rendering in tests. */
  now?: number;
}

export default function AlertsPanel({
  alerts,
  onSelect,
  selectedId = null,
  now,
}: AlertsPanelProps) {
  // Pure — derived straight from the input alerts so the panel re-renders
  // cleanly whenever the upstream snapshot changes.
  const groups = useMemo(() => groupByFamily(alerts), [alerts]);

  // Whole-panel collapse — during a multi-product outbreak the panel can
  // dominate the viewport even with per-family accordions, so the user can
  // fold it down to just the count badge. Session-only state; a reload
  // restores the expanded default because the typical reason to open the
  // app is to SEE the alerts.
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Relative-expiry labels need a "now" that ticks, but Date.now() in render
  // is impure. Lazy-initialize once, then re-tick every 30s via effect so the
  // "in Xm" strings stay fresh without re-fetching anything.
  const [internalNow, setInternalNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return; // test/external control — don't run the ticker
    const id = setInterval(() => setInternalNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [now]);
  const effectiveNow = now ?? internalNow;

  if (groups.length === 0) {
    return (
      <div
        className="absolute top-16 left-4 w-80 max-w-[calc(100vw-2rem)] bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 p-3 text-sm"
        role="region"
        aria-label="Active alerts"
      >
        <div className="font-semibold mb-1">Active alerts</div>
        <div className="text-xs text-gray-400">No active alerts.</div>
      </div>
    );
  }

  return (
    <div
      className={`absolute top-16 left-4 w-80 max-w-[calc(100vw-2rem)] bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 p-2 ${
        isCollapsed ? '' : 'max-h-[60vh] overflow-y-auto space-y-2'
      }`}
      role="region"
      aria-label="Active alerts"
    >
      <div className="flex items-center justify-between px-1 pt-1 pb-0.5">
        <span className="text-[11px] uppercase tracking-wide text-gray-400">
          Active alerts ({alerts.length})
        </span>
        <button
          type="button"
          onClick={() => setIsCollapsed((c) => !c)}
          aria-expanded={!isCollapsed}
          aria-controls="alerts-panel-body"
          aria-label={isCollapsed ? 'Expand alerts panel' : 'Collapse alerts panel'}
          className="text-gray-400 hover:text-white text-xs leading-none px-1.5 py-0.5 rounded hover:bg-gray-800"
          title={isCollapsed ? 'Expand' : 'Collapse'}
        >
          {isCollapsed ? '▸' : '▾'}
        </button>
      </div>
      {!isCollapsed && (
        <div id="alerts-panel-body" className="space-y-2">
          {groups.map(({ family, alerts: famAlerts }) => (
            <FamilySection
              key={family}
              family={family}
              alerts={famAlerts}
              selectedId={selectedId}
              onSelect={onSelect}
              now={effectiveNow}
            />
          ))}
        </div>
      )}
    </div>
  );
}
