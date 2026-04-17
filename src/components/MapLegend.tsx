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

export default function MapLegend() {
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
            {entries.map(([event, color]) => (
              <li key={event} className="flex items-center gap-2">
                <TierGlyph tier={tierForEvent(event)} color={color} />
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-sm border border-white/20"
                  style={{ backgroundColor: color }}
                />
                <span className="text-gray-100">{event}</span>
              </li>
            ))}
          </ul>

          <div className="pt-2 border-t border-gray-700 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-gray-400">Tier</div>
            <div className="flex items-center gap-2">
              <TierGlyph tier="Warning" color="#FF0000" />
              <span>Warning — take action</span>
            </div>
            <div className="flex items-center gap-2">
              <TierGlyph tier="Watch" color="#FFFF00" />
              <span>Watch — be aware</span>
            </div>
            <div className="flex items-center gap-2">
              <TierGlyph tier="Advisory" color="#FFE4B5" />
              <span>Advisory — monitor</span>
            </div>
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
