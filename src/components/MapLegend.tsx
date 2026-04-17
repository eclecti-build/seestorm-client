'use client';

import { useState } from 'react';
import { WARNING_COLORS, tierForEvent, type AlertTier } from '@/lib/alerts';

// Tier glyphs communicate the polygon treatment on the map at a glance.
// Keep them tiny — they sit next to a 14×14 color swatch inside a cramped
// panel and need to read at 11px.
function TierGlyph({ tier, color }: { tier: AlertTier; color: string }) {
  const size = 14;
  if (tier === 'Warning') {
    return (
      <svg width={size} height={size} aria-hidden="true">
        <rect width={size} height={size} fill={color} opacity={0.25} />
        <rect
          x={0.5}
          y={0.5}
          width={size - 1}
          height={size - 1}
          fill="none"
          stroke={color}
          strokeWidth={2}
        />
      </svg>
    );
  }
  if (tier === 'Watch') {
    return (
      <svg width={size} height={size} aria-hidden="true">
        <rect width={size} height={size} fill={color} opacity={0.12} />
        <rect
          x={0.5}
          y={0.5}
          width={size - 1}
          height={size - 1}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} aria-hidden="true">
      <rect width={size} height={size} fill={color} opacity={0.06} />
      <rect
        x={0.5}
        y={0.5}
        width={size - 1}
        height={size - 1}
        fill="none"
        stroke={color}
        strokeWidth={1}
      />
    </svg>
  );
}

function MotionGlyph() {
  return (
    <svg width={40} height={12} aria-hidden="true">
      <line x1={0} y1={6} x2={30} y2={6} stroke="#ffffff" strokeWidth={2} strokeDasharray="3 2" />
      <polygon points="30,1 40,6 30,11" fill="#ffffff" />
    </svg>
  );
}

// Tier rows in the legend double as map-filter toggles. Clicking a tier
// hides every alert polygon in that tier from the map (the side panel
// keeps showing them so situational awareness isn't lost). Kept to three
// tiers — tier-level granularity declutters fast without ballooning the
// UI into a checkbox soup of individual event types.
const TIER_DESCRIPTIONS: ReadonlyArray<{ tier: AlertTier; color: string; label: string }> = [
  { tier: 'Warning', color: '#FF0000', label: 'Warning — take action' },
  { tier: 'Watch', color: '#FFFF00', label: 'Watch — be aware' },
  { tier: 'Advisory', color: '#FFE4B5', label: 'Advisory — monitor' },
];

export interface MapLegendProps {
  hiddenTiers: ReadonlySet<AlertTier>;
  onToggleTier: (tier: AlertTier) => void;
}

export default function MapLegend({ hiddenTiers, onToggleTier }: MapLegendProps) {
  const [open, setOpen] = useState<boolean>(false);

  const entries = Object.entries(WARNING_COLORS);

  return (
    <div
      className="absolute bottom-28 left-4 bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 text-xs overflow-hidden max-w-[15rem]"
      role="region"
      aria-label="Map legend"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="map-legend-body"
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800 transition-colors"
      >
        <span className="font-semibold tracking-wide uppercase">Legend</span>
        <span aria-hidden="true" className="text-gray-400">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div id="map-legend-body" className="px-3 pb-3 space-y-3">
          <ul className="space-y-1.5">
            {entries.map(([event, color]) => {
              const tier = tierForEvent(event);
              const dim = hiddenTiers.has(tier);
              return (
                <li
                  key={event}
                  className={`flex items-center gap-2 transition-opacity ${
                    dim ? 'opacity-40' : 'opacity-100'
                  }`}
                >
                  <TierGlyph tier={tier} color={color} />
                  <span
                    aria-hidden="true"
                    className="inline-block w-3 h-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: color }}
                  />
                  <span className={`text-gray-100 ${dim ? 'line-through' : ''}`}>{event}</span>
                </li>
              );
            })}
          </ul>

          <div className="pt-2 border-t border-gray-700 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-gray-400">Tier</span>
              <span className="text-[10px] text-gray-500">click to toggle on map</span>
            </div>
            {TIER_DESCRIPTIONS.map(({ tier, color, label }) => {
              const hidden = hiddenTiers.has(tier);
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => onToggleTier(tier)}
                  aria-pressed={!hidden}
                  // Stable label so screen readers perceive a single toggle
                  // rather than a new control on each press. The pressed
                  // state (aria-pressed) carries the on/off meaning — this
                  // matches the WAI-ARIA APG toggle-button pattern.
                  aria-label={`Toggle ${tier} alerts on map`}
                  className={`w-full flex items-center gap-2 rounded px-1.5 py-1 transition-colors cursor-pointer hover:bg-gray-800 ${
                    hidden ? 'opacity-50' : ''
                  }`}
                >
                  <TierGlyph tier={tier} color={color} />
                  <span className={`flex-1 text-left ${hidden ? 'line-through' : ''}`}>
                    {label}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`text-[10px] uppercase tracking-wide ${
                      hidden ? 'text-gray-500' : 'text-emerald-400'
                    }`}
                  >
                    {hidden ? 'off' : 'on'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-gray-700 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-gray-400">Storm motion</div>
            <div className="flex items-center gap-2">
              <MotionGlyph />
              <span>Projected path (next 45 min)</span>
            </div>
            <div className="text-[10px] text-gray-400 pl-1">
              Ticks at 15 / 30 / 45 min · mph label at arrow
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
