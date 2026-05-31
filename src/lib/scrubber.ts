// Pure range math for the time scrubber in WeatherMap.
//
// The bar ends at the live edge (`historyLength`) by default, so "live" is the
// right end of the track and the live tracker can pulse there. The HRRR
// forecast frames are opt-in (the "+1h forecast" toggle): revealing them
// extends the range to the right.

import { HRRR_FRAME_COUNT } from './radar';

/**
 * Maximum value for the scrubber's range input.
 *
 * - forecast hidden → `historyLength` (the live edge; bar ends at live)
 * - forecast shown  → `historyLength + HRRR_FRAME_COUNT` (live + future frames)
 */
export function scrubberMax(historyLength: number, showForecast: boolean): number {
  return historyLength + (showForecast ? HRRR_FRAME_COUNT : 0);
}

/**
 * Clamp a slider position to the currently-visible range. When the forecast is
 * hidden, any position in the (now removed) forecast region snaps back to the
 * live edge so the thumb never sits past the end of the bar.
 */
export function clampToScrubberRange(
  value: number,
  historyLength: number,
  showForecast: boolean,
): number {
  return Math.min(Math.max(value, 0), scrubberMax(historyLength, showForecast));
}
