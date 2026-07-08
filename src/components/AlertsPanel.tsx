'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  colorForEvent,
  deriveMultiStateDisplay,
  groupByFamily,
  tierForEvent,
  type AlertFamily,
  type WeatherAlert,
} from '@/lib/alerts';
import { tornadoColor } from '@/lib/tornado';
import { useColorVisionMode } from '@/lib/preferences';
import { AlertIcon } from '@/lib/alertIcons';
import { useSnapshotState } from '@/lib/snapshotStore';
import { FETCH_DEGRADED_THRESHOLD } from '@/lib/constants';

// Family headers summarize a whole bucket of related events — we pick a
// representative event so the family icon agrees with `iconForEvent` for
// alerts inside. Map-key match lets substring-matched families (e.g.
// "Severe Thunderstorm" matching both Warnings and Watches) share a glyph.
const FAMILY_EVENT_EXEMPLAR: Record<AlertFamily, string> = {
  Tornado: 'Tornado Warning',
  'Severe Thunderstorm': 'Severe Thunderstorm Warning',
  'Flash Flood': 'Flash Flood Warning',
  // Plain hydrologic Flood family — shares the wave glyph with Flash Flood
  // (see alertIcons: `iconForEvent` substring-matches on 'Flood'), and the
  // Warning exemplar carries the red palette entry we just added.
  Flood: 'Flood Warning',
  Other: 'Special Weather Statement',
};

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
  userState,
}: {
  alert: WeatherAlert;
  selected: boolean;
  onSelect: (a: WeatherAlert) => void;
  now: number;
  userState?: string;
}) {
  // Tornado alerts use the normalized category color (magenta ramp); all
  // other events fall back to the standard per-event palette. Resolved from
  // the live color-vision mode (not the baked `tornadoColor` property, which
  // is always the default-palette hex) so colorblind mode recolors the panel.
  const mode = useColorVisionMode();
  const color = alert.properties.tornado
    ? tornadoColor(alert.properties.tornado, mode)
    : colorForEvent(alert.properties.event, mode);
  const tier = tierForEvent(alert.properties.event);
  const url = alert.properties.url;

  // Trim cross-border counties from the rendered areaDesc when we know the
  // user's state, and badge multi-state alerts so users understand the
  // alert also covers other states. Both derivations live in
  // `deriveMultiStateDisplay` so the selected-alert popup in WeatherMap
  // stays in lockstep. The underlying filter (`alertTouchesState`) is
  // unchanged — this is display-only cleanup.
  const { areaDesc, regionalLabel } = deriveMultiStateDisplay(alert, userState);

  return (
    <button
      type="button"
      onClick={() => onSelect(alert)}
      aria-pressed={selected}
      className={`w-full text-left p-2 rounded border transition-colors ${
        selected
          ? 'bg-gray-700 border-white/40'
          : 'bg-gray-800/80 border-gray-700 hover:bg-gray-800'
      } ${alert.properties.expired ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          aria-hidden="true"
          className="inline-block w-2.5 h-2.5 rounded-sm"
          style={{ backgroundColor: color }}
        />
        {/* Icon inherits the event color via `currentColor` so the glyph
            reads in the same hue as the title — reinforces the shape/color
            pairing for colorblind scanning without a second style override. */}
        <AlertIcon
          event={alert.properties.event}
          data-testid={`alert-card-icon-${alert.properties.event}`}
          className="shrink-0"
          style={{ color }}
        />
        <span
          className="text-[11px] font-bold uppercase tracking-wide"
          style={{ color }}
          title={alert.properties.tornadoLabelTitle}
        >
          {alert.properties.tornadoLabel ?? alert.properties.event}
        </span>
        {alert.properties.expired && (
          <span
            className="text-[9px] font-bold uppercase tracking-wide text-amber-400 border border-amber-400/60 rounded px-1"
            data-testid={`alert-card-expired-badge-${alert.properties.event}`}
          >
            Expired
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-400">{tier}</span>
      </div>
      <div className="text-xs text-gray-100 line-clamp-2">{areaDesc}</div>
      {regionalLabel && <div className="text-[10px] text-gray-400 mt-0.5">{regionalLabel}</div>}
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
  userState,
}: {
  family: AlertFamily;
  alerts: WeatherAlert[];
  selectedId: string | null;
  onSelect: (a: WeatherAlert) => void;
  now: number;
  userState?: string;
}) {
  const mode = useColorVisionMode();
  const color = colorForEvent(alerts[0]?.properties.event ?? '', mode);
  // The family header icon represents the whole bucket; we key off an
  // exemplar event rather than `alerts[0]` so an empty-family render (shouldn't
  // happen in practice, but defensive) still lands on the right glyph.
  const familyExemplar = FAMILY_EVENT_EXEMPLAR[family];
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
        <AlertIcon
          event={familyExemplar}
          data-testid={`alerts-family-icon-${family}`}
          className="shrink-0"
          style={{ color }}
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
            <AlertCard
              key={key}
              alert={a}
              selected={selected}
              onSelect={onSelect}
              now={now}
              userState={userState}
            />
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
  /**
   * USPS 2-letter code of the user's saved state (if any). When set, each
   * card trims its `areaDesc` to just the counties in this state and badges
   * multi-state alerts so users still see the full scope. Display-only —
   * does not change which alerts are rendered.
   */
  userState?: string;
}

export default function AlertsPanel({
  alerts,
  onSelect,
  selectedId = null,
  now,
  userState,
}: AlertsPanelProps) {
  // Pure — derived straight from the input alerts so the panel re-renders
  // cleanly whenever the upstream snapshot changes.
  const groups = useMemo(() => groupByFamily(alerts), [alerts]);
  const { consecutiveLiveFailures } = useSnapshotState();
  const fetchDegraded = consecutiveLiveFailures >= FETCH_DEGRADED_THRESHOLD;

  // Whole-panel collapse — during a multi-product outbreak the panel can
  // dominate the viewport even with per-family accordions, so the user can
  // fold it down to just the count badge. Session-only state; a reload
  // restores the expanded default because the typical reason to open the
  // app is to SEE the alerts.
  //
  // On mobile (<768px) we start collapsed so the map wins the viewport —
  // the panel covers most of the screen on a phone and the user can opt in
  // by tapping the header. SSR-safe: this component only renders under
  // dynamic(ssr:false), so `window` is defined at first paint.
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 768;
  });

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
        className="bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 p-3 text-sm w-fit max-w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))]"
        role="region"
        aria-label="Active alerts"
      >
        <div className="font-semibold mb-1">Active alerts</div>
        <div
          className={`text-xs ${fetchDegraded ? 'text-amber-400' : 'text-gray-400'}`}
          role={fetchDegraded ? 'status' : undefined}
          aria-live={fetchDegraded ? 'polite' : undefined}
        >
          {fetchDegraded ? 'Alert data unavailable — retrying…' : 'No active alerts.'}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 p-2 max-w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] ${
        isCollapsed
          ? 'w-fit shrink-0'
          : 'w-80 min-h-0 shrink ss-alerts-maxh overflow-y-auto space-y-2'
      }`}
      role="region"
      aria-label="Active alerts"
    >
      <button
        type="button"
        onClick={() => setIsCollapsed((c) => !c)}
        aria-expanded={!isCollapsed}
        aria-controls="alerts-panel-body"
        aria-label={isCollapsed ? 'Expand alerts panel' : 'Collapse alerts panel'}
        title={isCollapsed ? 'Expand' : 'Collapse'}
        // Sticky when expanded: the parent div is the scroll container
        // (`overflow-y-auto` + `ss-alerts-maxh`), so `sticky top-0` pins the
        // collapse toggle at the top of the viewport while the alert list
        // scrolls beneath it. Negative horizontal margin + bumped padding
        // lets the header span the full panel width (cancelling the parent's
        // `p-2`) so the sticky bar visually covers scrolling content behind.
        // `bg-gray-900/95` + `backdrop-blur-sm` match the panel surface so
        // content scrolling under it reads as layered, not clipped.
        className={`w-full flex items-center justify-between py-1 text-left rounded hover:bg-gray-800 transition-colors ${
          isCollapsed ? 'px-1.5' : 'sticky top-0 z-10 bg-gray-900/95 backdrop-blur-sm -mx-2 px-3.5'
        }`}
      >
        <span className="text-[11px] uppercase tracking-wide text-gray-400">
          Active alerts ({alerts.length})
        </span>
        <span aria-hidden="true" className="text-gray-400 text-xs leading-none px-1.5 py-0.5">
          {isCollapsed ? '▸' : '▾'}
        </span>
      </button>
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
              userState={userState}
            />
          ))}
        </div>
      )}
    </div>
  );
}
