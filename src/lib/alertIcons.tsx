// Understated, stroke-based glyphs for NWS alert event types.
//
// Why these exist:
//   - The legend and side panel already carry a color swatch, but color alone
//     fails for colorblind users and doesn't survive a dense outbreak where
//     five different amber shades stack. A small shape cue raises scannability
//     without shouting.
//   - We stay stroke-only on `currentColor` so the icons inherit whatever the
//     enclosing text color is. That keeps theming free (hover / disabled /
//     line-through states Just Work) and sidesteps the Tailwind-4 + inline-SVG
//     specificity fights that pop up when icons hardcode fills.
//   - 14×14 matches the existing `TierGlyph` / legend swatch cadence so rows
//     stay aligned at 11px type.
//
// Design constraints:
//   - No external icon deps. These are handwritten paths; reviewing a new SVG
//     in a PR is cheaper than auditing a new package.
//   - Keep each icon to ~1–3 primitives. Over-detail at 14px smudges into mud.
//   - Each component returns a bare <svg>; callers wrap it with `aria-hidden`
//     context if a nearby label exists. Consumers that need standalone a11y
//     pass their own aria-label via the wrapping element.

import type { ComponentType, SVGProps } from 'react';

export type AlertIconProps = SVGProps<SVGSVGElement>;

const BASE_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 14 14',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

// Tornado: a narrowing funnel. Three horizontal ticks suggest rotation without
// the cartoon swirl most "tornado" icons resort to.
export const TornadoIcon: ComponentType<AlertIconProps> = (props) => (
  <svg {...BASE_PROPS} {...props}>
    <path d="M2 3 L12 3" />
    <path d="M3.5 6.5 L10.5 6.5" />
    <path d="M5 10 L9 10" />
    <path d="M6.5 12.5 L7.5 12.5" />
  </svg>
);

// Severe Thunderstorm: a cloud with a bolt. Bolt-only would read as generic
// "warning", so we keep the cloud arc to anchor the product family.
export const ThunderstormIcon: ComponentType<AlertIconProps> = (props) => (
  <svg {...BASE_PROPS} {...props}>
    <path d="M3 7.5 A2.5 2.5 0 0 1 5.5 5 A3 3 0 0 1 11 5.5 A2 2 0 0 1 11 9.5 L4 9.5 A2 2 0 0 1 3 7.5 Z" />
    <path d="M7.5 7.5 L6 11 L8 11 L6.5 13" />
  </svg>
);

// Flash Flood: wavy water lines. Three stacked waves read as "water level"
// without needing a house/car prop.
export const FloodIcon: ComponentType<AlertIconProps> = (props) => (
  <svg {...BASE_PROPS} {...props}>
    <path d="M2 5 Q4 3.5 6 5 T10 5 T12 5" />
    <path d="M2 8 Q4 6.5 6 8 T10 8 T12 8" />
    <path d="M2 11 Q4 9.5 6 11 T10 11 T12 11" />
  </svg>
);

// Special Weather Statement / generic advisory: an info "i" in a circle.
// Deliberately low-urgency — SPSes are the least severe product in our palette.
export const InfoIcon: ComponentType<AlertIconProps> = (props) => (
  <svg {...BASE_PROPS} {...props}>
    <circle cx="7" cy="7" r="5" />
    <path d="M7 6 L7 10" />
    <path d="M7 4.25 L7 4.75" />
  </svg>
);

// Freeze / Frost: a minimal 6-point snowflake built from three crossing lines.
// Echoes the "three primitives" cadence of TornadoIcon and FloodIcon and reads
// as "cold" without the cartoon snowflake shorthand (dots, serifs, twelve
// arms). Kept stroke-only so it inherits the event's color the same way the
// others do.
export const FreezeIcon: ComponentType<AlertIconProps> = (props) => (
  <svg {...BASE_PROPS} {...props}>
    <path d="M7 2 L7 12" />
    <path d="M2.7 4.5 L11.3 9.5" />
    <path d="M2.7 9.5 L11.3 4.5" />
  </svg>
);

// Fallback: a neutral diamond. "Something's here, we just don't have a
// dedicated glyph for it yet." Better than crashing the row or falling back
// to a tier glyph that would duplicate the swatch.
export const GenericAlertIcon: ComponentType<AlertIconProps> = (props) => (
  <svg {...BASE_PROPS} {...props}>
    <path d="M7 2 L12 7 L7 12 L2 7 Z" />
  </svg>
);

/**
 * Map an NWS event_type string to the icon component that best represents it.
 *
 * Substring-based so cousins of the named products (e.g. "Tornado Emergency",
 * "Flood Advisory") land on the right glyph without bespoke rows. Matches the
 * same grouping philosophy as `alertFamily()` in `alerts.ts`, so the icon and
 * the family section header always agree.
 */
export function iconForEvent(event: string): ComponentType<AlertIconProps> {
  if (event.includes('Tornado')) return TornadoIcon;
  if (event.includes('Thunderstorm')) return ThunderstormIcon;
  // "Flash Flood" is the urgent variant; plain "Flood" (Flood Warning, Flood
  // Advisory, Flood Watch) is the slower-moving cousin. Both land on the same
  // water-line glyph because the visual cue — "this is water" — is identical.
  if (event.includes('Flood')) return FloodIcon;
  // Freeze / Frost / Hard Freeze all share the snowflake. Substring match so
  // "Hard Freeze Warning" and future cousins ("Freezing Fog Advisory"?) land
  // here without bespoke rows.
  if (event.includes('Freeze') || event.includes('Frost')) return FreezeIcon;
  if (event.includes('Special Weather Statement')) return InfoIcon;
  return GenericAlertIcon;
}

/**
 * Render-safe wrapper: dispatches to the right icon internally via a `switch`
 * that renders each leaf component with a stable JSX reference. Callers can
 * use this inside JSX without tripping the `react-hooks/static-components`
 * lint rule — that rule fires when a component is assigned to a local
 * variable inside render, because React treats the local variable as a new
 * component identity on every render.
 *
 * Our leaf icons are stateless SVGs, so the state-loss concern the lint rule
 * guards against doesn't bite — but the rule is still correct in general,
 * and going through this wrapper keeps the codebase clean without peppering
 * disable comments across call sites.
 */
export function AlertIcon({ event, ...props }: AlertIconProps & { event: string }) {
  if (event.includes('Tornado')) return <TornadoIcon {...props} />;
  if (event.includes('Thunderstorm')) return <ThunderstormIcon {...props} />;
  if (event.includes('Flood')) return <FloodIcon {...props} />;
  if (event.includes('Freeze') || event.includes('Frost')) return <FreezeIcon {...props} />;
  if (event.includes('Special Weather Statement')) return <InfoIcon {...props} />;
  return <GenericAlertIcon {...props} />;
}
