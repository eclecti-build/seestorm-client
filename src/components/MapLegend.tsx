'use client';

import { useState } from 'react';
import { warningColorsFor, tierForEvent, type AlertTier } from '@/lib/alerts';
import { AlertIcon } from '@/lib/alertIcons';
import { tornadoCategoryColorsFor, type TornadoCategory } from '@/lib/tornado';
import { useColorVisionMode } from '@/lib/preferences';

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

function TornadoStatusGlyph({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <svg width={34} height={14} viewBox="0 0 34 14" aria-hidden="true">
      {pulse && (
        <rect
          x={1}
          y={1}
          width={32}
          height={12}
          fill="none"
          stroke={color}
          strokeWidth={1}
          opacity={0.35}
        />
      )}
      <rect
        x={pulse ? 5 : 3}
        y={pulse ? 3 : 2}
        width={pulse ? 24 : 28}
        height={pulse ? 8 : 10}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
      />
    </svg>
  );
}

// Glyph for the on-map-text toggle: a small label/caption motif so the
// control reads as "words on the map" without needing a text label of
// its own. Sized to match TornadoStatusGlyph (34×14) for column align.
function CtaTextGlyph() {
  return (
    <svg width={34} height={14} viewBox="0 0 34 14" aria-hidden="true">
      <rect
        x={1}
        y={1}
        width={32}
        height={12}
        rx={1.5}
        fill="none"
        stroke="#ffffff"
        strokeWidth={1}
        opacity={0.5}
      />
      <line x1={5} y1={6} x2={29} y2={6} stroke="#ffffff" strokeWidth={1.5} />
      <line x1={5} y1={9.5} x2={21} y2={9.5} stroke="#ffffff" strokeWidth={1.5} />
    </svg>
  );
}

const TORNADO_STATUS_DESCRIPTIONS: ReadonlyArray<{
  category: TornadoCategory;
  label: string;
  description: string;
  pulse?: boolean;
}> = [
  {
    category: 'RADAR_INDICATED',
    label: 'Radar indicated',
    description: 'Rotation detected; tornado not confirmed',
  },
  {
    category: 'CONFIRMED',
    label: 'Confirmed',
    description: 'Verified tornado; take cover',
    pulse: true,
  },
  {
    category: 'PDS',
    label: 'Particularly dangerous',
    description: 'Confirmed strong tornado',
    pulse: true,
  },
  {
    category: 'EMERGENCY',
    label: 'Tornado emergency',
    description: 'Confirmed violent tornado',
    pulse: true,
  },
];

export interface MapLegendProps {
  hiddenTiers: ReadonlySet<AlertTier>;
  onToggleTier: (tier: AlertTier) => void;
  // Per-event visibility — independent of tier toggles so users can e.g.
  // hide "Tornado Watch" while keeping every other Watch on the map.
  // Session-only in WeatherMap state; persistence is tracked in
  // eclecti-build/seestorm-client issue for the legend-persistence follow-up.
  hiddenEvents: ReadonlySet<string>;
  onToggleEvent: (event: string) => void;
  // On-map confirmed-tornado CTA text ("TAKE COVER") — the ONLY verbiage
  // drawn over the basemap. Toggleable because not everyone wants words on
  // the map; the pulse/halo emphasis is deliberately unaffected. State is
  // owned by WeatherMap (session-only, default on).
  showTornadoCta: boolean;
  onToggleTornadoCta: () => void;
}

export default function MapLegend({
  hiddenTiers,
  onToggleTier,
  hiddenEvents,
  onToggleEvent,
  showTornadoCta,
  onToggleTornadoCta,
}: MapLegendProps) {
  const [open, setOpen] = useState<boolean>(false);

  const mode = useColorVisionMode();
  const warningColors = warningColorsFor(mode);
  const tornadoColors = tornadoCategoryColorsFor(mode);

  const TIER_DESCRIPTIONS: ReadonlyArray<{ tier: AlertTier; color: string; label: string }> = [
    { tier: 'Warning', color: warningColors['Tornado Warning'], label: 'Warning — take action' },
    { tier: 'Watch', color: warningColors['Tornado Watch'], label: 'Watch — be aware' },
    {
      tier: 'Advisory',
      color: warningColors['Special Weather Statement'],
      label: 'Advisory — monitor',
    },
  ];

  const entries = Object.entries(warningColors);

  return (
    // No self-positioning — this flows inline as the last child of the
    // top-left panel column (below the location selector, its expected
    // home). It does NOT reintroduce the old heavy stack: the parent
    // column is content-sized (not fixed-height `overflow-hidden`), and
    // the legend is lightweight (collapsed by default, per-event list
    // behind a disclosure). Collapsed hugs the "LEGEND ▸" header so the
    // chip doesn't eat mobile width; expanded grows to a comfortable
    // reading width and the body (#map-legend-body) still caps its own
    // height + scrolls internally so a long open legend can't run off a
    // short screen.
    <div
      className={`bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 text-xs overflow-hidden max-w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] ${
        open ? 'w-72' : 'w-fit'
      }`}
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
        <div
          id="map-legend-body"
          className="ss-legend-maxh overflow-y-auto overscroll-contain px-3 pb-3 space-y-3"
        >
          <div className="space-y-1">
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

          {/* Per-event visibility — collapsed by default. The tier toggles
              above cover the common "cut the noise" case; this finer-grained
              control is opt-in so the open legend stays short. The full
              per-event list was the single biggest contributor to the heavy
              stacked panel, so it no longer adds height until summoned.
              Native <details> matches the AlertsPanel FamilySection
              disclosure idiom and is keyboard-accessible for free. */}
          <details className="pt-2 border-t border-gray-700">
            <summary className="cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-wide text-gray-400 hover:text-gray-200">
              <span>Per-event visibility</span>
              <span className="text-gray-500">({entries.length})</span>
            </summary>
            <ul className="space-y-1.5 pt-2">
              {entries.map(([event, color]) => {
                const tier = tierForEvent(event);
                // Two independent reasons a row can be "off" on the map:
                //   - its tier is hidden (bulk toggle below)
                //   - the event itself is hidden (this row's button)
                // We visually reflect either; aria-pressed reports the
                // row-level state only, so the screen-reader announcement
                // matches the button the user just clicked.
                const tierHidden = hiddenTiers.has(tier);
                const eventHidden = hiddenEvents.has(event);
                const dim = tierHidden || eventHidden;
                return (
                  <li key={event}>
                    <button
                      type="button"
                      onClick={() => onToggleEvent(event)}
                      aria-pressed={!eventHidden}
                      // Stable label across press state so screen readers see
                      // one control, not a new one per press (WAI-ARIA APG
                      // toggle-button pattern, same as the tier toggles below).
                      aria-label={`Toggle ${event} on map`}
                      className={`w-full flex items-center gap-2 rounded px-1 py-0.5 transition-opacity cursor-pointer hover:bg-gray-800 ${
                        dim ? 'opacity-40' : 'opacity-100'
                      }`}
                    >
                      <TierGlyph tier={tier} color={color} />
                      <span
                        aria-hidden="true"
                        className="inline-block w-3 h-3 rounded-sm border border-white/20"
                        style={{ backgroundColor: color }}
                      />
                      {/* Event-type glyph rides on `currentColor`, so it picks
                        up the row's text color automatically — no prop
                        plumbing for hover / disabled / line-through. Sits
                        between the color swatch and the label so colorblind
                        scanning lines up left-to-right: shape → color → name. */}
                      <AlertIcon
                        event={event}
                        data-testid={`map-legend-icon-${event}`}
                        className="shrink-0 text-gray-100"
                      />
                      <span
                        className={`flex-1 text-left text-gray-100 ${
                          eventHidden ? 'line-through' : ''
                        }`}
                      >
                        {event}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`text-[10px] uppercase tracking-wide ${
                          eventHidden ? 'text-gray-500' : 'text-emerald-400'
                        }`}
                      >
                        {eventHidden ? 'off' : 'on'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>

          <div className="pt-2 border-t border-gray-700 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-gray-400">Tornado status</div>

            {/* On-map text toggle. The only verbiage drawn over the map is
                the confirmed-tornado CTA; it's a public-safety message so it
                defaults on, but it's the kind of thing not everyone wants
                billboarded, so it's user-controllable here. Same
                toggle-button + aria-pressed idiom as the tier/event rows
                (WAI-ARIA APG). Hiding it never touches the pulse/halo — the
                wordless emphasis still marks confirmed tornadoes. */}
            <button
              type="button"
              onClick={onToggleTornadoCta}
              aria-pressed={showTornadoCta}
              // Stable label across press state so screen readers perceive a
              // single toggle, not a new control per press.
              aria-label="Toggle on-map tornado alert text"
              className="w-full flex items-center gap-2 rounded px-1.5 py-1 transition-colors cursor-pointer hover:bg-gray-800"
            >
              <CtaTextGlyph />
              <span className="flex-1 text-left leading-tight">
                On-map alert text
                <span className="block text-[9px] text-gray-400">
                  “TAKE COVER” over confirmed tornadoes
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`text-[10px] uppercase tracking-wide ${
                  showTornadoCta ? 'text-emerald-400' : 'text-gray-500'
                }`}
              >
                {showTornadoCta ? 'on' : 'off'}
              </span>
            </button>

            <ul className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {TORNADO_STATUS_DESCRIPTIONS.map(({ category, label, description, pulse }) => (
                <li key={category} className="flex items-start gap-1.5">
                  <TornadoStatusGlyph color={tornadoColors[category]} pulse={pulse} />
                  <div className="min-w-0">
                    <div className="text-gray-100 leading-tight">{label}</div>
                    <div className="text-[9px] leading-tight text-gray-400">{description}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="pt-2 border-t border-gray-700 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400">
              <span>Storm motion</span>
              {/* The arrow is a straight-line dead-reckoning projection from
                  the single motion vector NWS encodes in the warning — it
                  reads more authoritative than it is, so spell out that it
                  is NOT an official forecast. Title for pointer hover;
                  role/aria-label so the same caveat reaches screen readers. */}
              <span
                tabIndex={0}
                role="img"
                aria-label="Straight-line projection from the warning's reported motion — not an NWS forecast or predicted track."
                title="Straight-line projection from the warning's reported motion — not an NWS forecast or predicted track."
                className="inline-flex h-3 w-3 items-center justify-center rounded-full border border-gray-500 text-[8px] normal-case text-gray-400 cursor-help"
              >
                i
              </span>
            </div>
            <div className="flex items-center gap-2">
              <MotionGlyph />
              <span>Estimated track if the storm holds its course and speed</span>
            </div>
            <div className="text-[10px] text-gray-400 pl-1">
              Dashed path to +45 min · ticks at 15 / 30 / 45 min · mph at arrow — not an NWS
              forecast
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
