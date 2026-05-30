// Pure builders for the MapLibre 'match' color expressions used by WeatherMap.
// Kept free of any `maplibre-gl` import so they are unit-testable without a DOM
// or WebGL context. WeatherMap casts the returned arrays to ExpressionSpecification.
//
// IMPORTANT: `DEFAULT_EVENT_ORDER` intentionally omits Freeze* and Special
// Weather Statement. Those events fall through to the gray fallback on the MAP
// today (the legend/side-panel still color them via WARNING_COLORS). Preserving
// that exactly is what keeps DEFAULT mode visually identical.
//
// In cbFriendly mode we ALSO color those families on the map (CB_EXTRA_ORDER) —
// leaving them gray would contradict the whole point of the mode, since the CB
// palette defines distinct hues for them and the legend/panel already show them.
// This asymmetry is deliberate: default unchanged, colorblind mode consistent.

import type { ColorVisionMode } from './colorVisionMode';
import { warningColorsFor, fallbackColorFor } from './alerts';
import { tornadoCategoryColorsFor } from './tornado';

const DEFAULT_EVENT_ORDER = [
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Flash Flood Warning',
  'Flash Flood Watch',
  'Flood Warning',
  'Flood Watch',
  'Flood Advisory',
  'Flood Statement',
] as const;

const CB_EXTRA_ORDER = ['Freeze Warning', 'Freeze Watch', 'Special Weather Statement'] as const;

export function buildEventColorExpression(mode: ColorVisionMode): unknown[] {
  const colors = warningColorsFor(mode);
  const events =
    mode === 'cbFriendly' ? [...DEFAULT_EVENT_ORDER, ...CB_EXTRA_ORDER] : DEFAULT_EVENT_ORDER;
  const cases: unknown[] = [];
  for (const event of events) {
    cases.push(event, colors[event]);
  }
  return ['match', ['get', 'event'], ...cases, fallbackColorFor(mode)];
}

export function buildTornadoColorExpression(mode: ColorVisionMode): unknown[] {
  const c = tornadoCategoryColorsFor(mode);
  return [
    'match',
    ['get', 'tornadoCategory'],
    'RADAR_INDICATED',
    c.RADAR_INDICATED,
    'CONFIRMED',
    c.CONFIRMED,
    'PDS',
    c.PDS,
    'EMERGENCY',
    c.EMERGENCY,
    c.RADAR_INDICATED,
  ];
}
