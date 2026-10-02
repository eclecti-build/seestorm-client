import type { RadarIndicator } from '@/lib/radarStatus';

const LABELS: Record<Exclude<RadarIndicator, null>, string> = {
  loading: 'Radar loading',
  error: 'Radar delayed, retrying',
};

// Only live mode retries a failed frame (the 30s poll starts a fresh gated
// refresh); a historical or forecast frame stays failed until it changes.
const UNAVAILABLE_LABEL = 'Radar unavailable for this frame';

/**
 * Three pulsing dots shown just above the time-slider bar while the radar is
 * slow to load or a tile request has failed, with a short visible label
 * saying what is being waited on — dots alone don't tell the user that it is
 * the radar (not the whole site) that is delayed. Hue-neutral (light on a
 * dark pill): the meaning is carried by the dots and the words, never colour.
 * Shows nothing when the radar is healthy.
 *
 * The live region is always mounted (screen-reader-only) and only its text
 * changes: many screen readers skip a live region inserted already holding
 * its text. The visible pill is aria-hidden so the label isn't read twice.
 *
 * Positioned against its parent: WeatherMap mounts it inside the bottom
 * slider block, so `bottom-full` sits it directly above that block, which
 * already pads for the bottom safe-area inset. Below `sm` it is left-aligned
 * with the slider's inset and capped to stop 0.5rem short of MapControlStack
 * (right 0.75rem + 2.75rem buttons), wrapping the label instead of running
 * under those buttons; from `sm` up it is centred on one line.
 */
export default function RadarStatusIndicator({
  state,
  live,
}: {
  state: RadarIndicator;
  live: boolean;
}) {
  const label =
    state === null ? '' : state === 'error' && !live ? UNAVAILABLE_LABEL : LABELS[state];
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
      {state !== null && (
        <div
          aria-hidden="true"
          data-testid="radar-status"
          data-state={state}
          className="pointer-events-none absolute bottom-full left-[calc(1rem+env(safe-area-inset-left))] max-w-[calc(100%-5rem-env(safe-area-inset-left)-env(safe-area-inset-right))] sm:left-1/2 sm:max-w-none sm:-translate-x-1/2 mb-1 flex items-center gap-2 rounded-full border border-gray-500/70 bg-gray-900/90 px-4 py-2.5 shadow-lg"
        >
          <span className="ss-radar-dot shrink-0" />
          <span className="ss-radar-dot shrink-0" />
          <span className="ss-radar-dot shrink-0" />
          {/* Label follows the dots so their :nth-child pulse stagger holds. */}
          <span className="ml-1 text-xs font-semibold text-[var(--ss-ink)] sm:whitespace-nowrap">
            {label}
          </span>
        </div>
      )}
    </>
  );
}
