// MapLibre filter-expression builders for the alert polygon layers.
//
// Extracted from WeatherMap.tsx so the filter math can be unit-tested without
// a real map. Kept intentionally pure — no React, no DOM, only structural
// MapLibre types — so tests can assert expression shapes directly.
//
// Two dimensions of filtering stack:
//   1. Tier (Warning / Watch / Advisory) — which of three rendering layers
//      an alert belongs to. Suffix-match on the `event` string so new NWS
//      event types route into the right tier without code changes.
//   2. Per-event visibility — individual event types the user has hidden
//      from the legend (e.g. "show only Tornado Warnings"). Excluded via
//      an `["in", event, [...hiddenEvents]]` membership test wrapped in `!`.

import type { ExpressionSpecification, FilterSpecification } from 'maplibre-gl';
import type { AlertTier } from './alerts';

const WARNING_SUFFIX = ' Warning';
const WATCH_SUFFIX = ' Watch';

/**
 * Base tier filter — selects every event whose name ends with the tier suffix
 * (or neither, for Advisory). Matches the suffix strategy from WeatherMap.tsx
 * at commit b96fe61 so visible behavior is byte-for-byte identical when no
 * events are hidden.
 *
 * Typed as `ExpressionSpecification` (the modern expression form) rather than
 * the broader `FilterSpecification`, because `FilterSpecification`'s legacy
 * variant bans nested expressions — composing it inside `['all', ...]` in
 * `alertLayerFilter` would then fail to narrow.
 */
export function baseTierFilter(tier: AlertTier): ExpressionSpecification {
  if (tier === 'Warning') {
    return ['==', ['slice', ['get', 'event'], -WARNING_SUFFIX.length], WARNING_SUFFIX];
  }
  if (tier === 'Watch') {
    return ['==', ['slice', ['get', 'event'], -WATCH_SUFFIX.length], WATCH_SUFFIX];
  }
  return [
    'all',
    ['!=', ['slice', ['get', 'event'], -WARNING_SUFFIX.length], WARNING_SUFFIX],
    ['!=', ['slice', ['get', 'event'], -WATCH_SUFFIX.length], WATCH_SUFFIX],
  ];
}

/**
 * Final layer filter: base tier filter AND-composed with a
 * per-event exclusion clause. When `hiddenEvents` is empty, we return the
 * bare base filter so the expression tree stays as short as possible and the
 * empty-set path is guaranteed-equivalent to pre-rework behavior.
 *
 * NOTE: `['literal', [...]]` is required when an array value appears inside
 * an expression — without it, MapLibre rejects the bare array at validation.
 */
export function alertLayerFilter(
  tier: AlertTier,
  hiddenEvents: ReadonlySet<string>,
): FilterSpecification {
  const base = baseTierFilter(tier);
  if (hiddenEvents.size === 0) return base;
  return ['all', base, ['!', ['in', ['get', 'event'], ['literal', [...hiddenEvents]]]]];
}

/**
 * Wrap a paint-property expression so it is dimmed by `factor` for features
 * whose `expired` property is `true` (alerts past `expires` but still
 * within the grace window — ALERT_EXPIRY_GRACE_MS in constants.ts). Works
 * for both a literal opacity number and a zoom-interpolated expression.
 * MapLibre requires zoom `step`/`interpolate` curves to remain the outermost
 * paint expression, so zoom-interpolated bases push the dim factor into each
 * stop output instead of wrapping the whole curve.
 */
export function dimIfExpired(
  base: number | ExpressionSpecification,
  factor: number,
): ExpressionSpecification {
  const dimFactor = ['case', ['==', ['get', 'expired'], true], factor, 1];
  if (Array.isArray(base) && base[0] === 'interpolate') {
    // MapLibre requires zoom curves to be the outermost expression in a
    // paint value ('Only one zoom-based step/interpolate subexpression may
    // be used'), so the dim factor is pushed into each output stop instead
    // of wrapping the whole curve.
    const [op, interpolation, input, ...stops] = base as unknown[];
    const rebuilt: unknown[] = [op, interpolation, input];
    for (let i = 0; i < stops.length; i += 2) {
      rebuilt.push(stops[i], ['*', stops[i + 1], dimFactor]);
    }
    return rebuilt as unknown as ExpressionSpecification;
  }
  return ['*', base, dimFactor] as unknown as ExpressionSpecification;
}
