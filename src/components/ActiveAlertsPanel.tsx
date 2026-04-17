'use client';

// Minimal floating panel that lists every currently-active NWS alert,
// regardless of whether it carries polygon geometry. Zone-aggregate products
// (SPC Tornado Watches, Severe Thunderstorm Watches, county-wide Flash Flood
// Watches) have no polygon and therefore can't be painted on the map, but they
// are still safety-critical — users need to see them surfaced somewhere.
//
// Sort order matches the MapLibre render priority used in WeatherMap so the
// most urgent event is always at the top of the list.

import type { ActiveAlert } from './alertTypes';

interface ActiveAlertsPanelProps {
  alerts: ActiveAlert[];
  colors: Record<string, string>;
  priority: Record<string, number>;
  // `now` is injected so the panel re-renders its "expires in Xm" label at the
  // same cadence the map's "Xm ago" label ticks — avoids two separate timers.
  now: number;
}

function sortByPriority(alerts: ActiveAlert[], priority: Record<string, number>): ActiveAlert[] {
  // Unknown events sort to the bottom. Stable — identical priorities keep
  // their relative order from the ingest snapshot (which is already
  // newest-effective-first).
  return alerts.slice().sort((a, b) => {
    const pa = priority[a.event_type] ?? 99;
    const pb = priority[b.event_type] ?? 99;
    return pa - pb;
  });
}

function expiresLabel(expiresAt: string, nowMs: number): string {
  const exp = new Date(expiresAt).getTime();
  if (!Number.isFinite(exp)) return '';
  const diffMin = Math.round((exp - nowMs) / 60_000);
  if (diffMin <= 0) return 'expired';
  if (diffMin < 60) return `expires in ${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins === 0 ? `expires in ${hours}h` : `expires in ${hours}h ${mins}m`;
}

export default function ActiveAlertsPanel({
  alerts,
  colors,
  priority,
  now,
}: ActiveAlertsPanelProps) {
  if (alerts.length === 0) return null;

  const sorted = sortByPriority(alerts, priority);

  return (
    <div
      className="absolute bottom-28 left-4 w-80 max-h-[40vh] overflow-y-auto bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700"
      role="region"
      aria-label="Active weather alerts"
    >
      <div className="sticky top-0 bg-gray-900/95 border-b border-gray-700 px-3 py-2 text-xs font-semibold uppercase tracking-wide">
        Active alerts ({sorted.length})
      </div>
      <ul className="divide-y divide-gray-800">
        {sorted.map((a) => {
          const color = colors[a.event_type] ?? '#888888';
          const zoneOnly = a.geometry === null;
          return (
            <li key={a.nws_id} className="px-3 py-2">
              <div className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1 inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <div className="min-w-0 flex-1">
                  <div
                    className="text-xs font-bold uppercase tracking-wide truncate"
                    style={{ color }}
                  >
                    {a.event_type}
                    {zoneOnly && (
                      <span
                        className="ml-2 text-[10px] font-semibold text-gray-400 uppercase"
                        title="Zone-aggregate product — no polygon on map"
                      >
                        zone
                      </span>
                    )}
                  </div>
                  {a.headline && (
                    <div className="text-xs text-gray-200 mt-0.5 line-clamp-2">{a.headline}</div>
                  )}
                  {a.area_desc && (
                    <div className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">
                      {a.area_desc}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {expiresLabel(a.expires_at, now)}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
