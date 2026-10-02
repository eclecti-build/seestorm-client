import type { RadarIndicator } from '@/lib/radarStatus';

const LABELS: Record<Exclude<RadarIndicator, null>, string> = {
  loading: 'Radar loading',
  error: 'Radar delayed, retrying',
};

/**
 * Three pulsing dots shown just above the time-slider bar while the radar is
 * slow to load or a tile request has failed, with a short visible label
 * saying what is being waited on — dots alone don't tell the user that it is
 * the radar (not the whole site) that is delayed. Hue-neutral (light on a
 * dark pill): the meaning is carried by the dots and the words, never colour.
 * Renders nothing when the radar is healthy.
 *
 * Positioned against its parent: WeatherMap mounts it inside the bottom
 * slider block, so `bottom-full` sits it directly above that block, which
 * already pads for the bottom safe-area inset.
 */
export default function RadarStatusIndicator({ state }: { state: RadarIndicator }) {
  if (state === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="radar-status"
      data-state={state}
      className="ss-radar-status pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 flex items-center gap-2 rounded-full border border-gray-500/70 bg-gray-900/90 px-4 py-2.5 shadow-lg"
    >
      <span className="ss-radar-dot" aria-hidden="true" />
      <span className="ss-radar-dot" aria-hidden="true" />
      <span className="ss-radar-dot" aria-hidden="true" />
      {/* Label follows the dots so their :nth-child pulse stagger holds. */}
      <span className="ml-1 whitespace-nowrap text-xs font-semibold text-gray-100">
        {LABELS[state]}
      </span>
    </div>
  );
}
