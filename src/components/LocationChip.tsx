'use client';

// LocationChip — compact collapsible control below AlertsPanel that lets
// users set a home ZIP. Styled like MapLegend (small bubble, header + ▸/▾
// chevron, body only rendered when open) so it sits unobtrusively in the
// top-left panel stack rather than overlaying the map as a card.
//
// Two visual states:
//   1. Collapsed — header-only bubble showing the saved ZIP as a chip, or
//                  a "Set location" prompt when none is saved yet. One line.
//   2. Expanded  — bubble grows to reveal the ZIP input + Save button, plus
//                  error state and coverage footer.
//
// There is intentionally no dismiss/hide — MapLegend follows the same
// always-visible rule. A persistent hide proved to be a UX trap in the
// previous LocationBanner: once a user clicked ×, the banner was gone for
// good until they cleared localStorage by hand. Collapsed is already just
// one line, so there's nothing for a dismiss button to buy us.
//
// All persistence flows through `userLocation.ts` so this component and
// WeatherMap stay in sync via the storage event.

import { useCallback, useEffect, useState } from 'react';
import {
  clearUserLocation,
  setUserLocation,
  useUserLocation,
  type UserLocation,
} from '@/lib/userLocation';
import { lookupZip, normalizeZip } from '@/lib/zipLookup';

type Mode = 'collapsed' | 'expanded';

interface LocationChipProps {
  /**
   * Fired whenever the saved location changes (set or cleared). Keeps the
   * map's userState filter in sync without requiring the parent to
   * subscribe to localStorage events itself.
   */
  onLocationChange?: (next: { state: string; lat: number; lon: number } | null) => void;
}

export default function LocationChip({ onLocationChange }: LocationChipProps) {
  const { location, hydrated } = useUserLocation();
  const [mode, setMode] = useState<Mode>('collapsed');
  const [zipInput, setZipInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mirror the saved ZIP into the input so editing starts from the current
  // value instead of an empty field. Kept in an effect (rather than derived
  // state) so manual edits aren't overwritten while the user is typing.
  useEffect(() => {
    if (!hydrated) return;
    if (location) {
      setZipInput(location.zip);
    }
  }, [hydrated, location]);

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);
      const normalized = normalizeZip(zipInput);
      if (!normalized) {
        setError('Enter a 5-digit ZIP code.');
        return;
      }
      setBusy(true);
      try {
        const record = await lookupZip(normalized);
        if (!record) {
          setError(
            `ZIP ${normalized} isn't in our coverage area (MN, WI, IL, IN, MI, OH, PA, NY).`,
          );
          return;
        }
        const next: UserLocation = {
          zip: normalized,
          state: record.state,
          lat: record.lat,
          lon: record.lon,
          source: 'manual',
          setAt: Date.now(),
        };
        setUserLocation(next);
        setMode('collapsed');
        onLocationChange?.({ state: record.state, lat: record.lat, lon: record.lon });
      } catch (err) {
        console.error('ZIP lookup failed', err);
        setError('Could not load ZIP table. Try again in a moment.');
      } finally {
        setBusy(false);
      }
    },
    [zipInput, onLocationChange],
  );

  const handleClear = useCallback(() => {
    clearUserLocation();
    setZipInput('');
    // Stay expanded after clear so the user can enter a different ZIP
    // without a second click.
    setMode('expanded');
    onLocationChange?.(null);
  }, [onLocationChange]);

  // Render nothing until hydration finishes (avoids SSR/CSR mismatch from
  // the localStorage read in useUserLocation).
  if (!hydrated) return null;

  const open = mode === 'expanded';
  const summary = location ? `${location.zip} · ${location.state}` : 'Set location';

  return (
    <div
      className="bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 text-xs overflow-hidden max-w-[15rem]"
      role="region"
      aria-label="Location filter"
    >
      <button
        type="button"
        onClick={() => setMode(open ? 'collapsed' : 'expanded')}
        aria-expanded={open}
        aria-controls="location-chip-body"
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-semibold tracking-wide uppercase text-gray-300">Location</span>
          <span className="font-mono text-white truncate">{summary}</span>
        </span>
        <span aria-hidden="true" className="text-gray-400 ml-2 shrink-0">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div id="location-chip-body" className="px-3 pb-3 pt-1 space-y-2">
          {location && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
              <span>Filtering alerts to {location.state}.</span>
              <button
                type="button"
                onClick={handleClear}
                className="text-gray-400 hover:text-white underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>
          )}

          <form onSubmit={submit}>
            <label htmlFor="zip-chip-input" className="sr-only">
              Enter ZIP code
            </label>
            <div className="flex items-center gap-2">
              <input
                id="zip-chip-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={10}
                value={zipInput}
                onChange={(e) => setZipInput(e.target.value)}
                placeholder="ZIP"
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                aria-invalid={error !== null}
                autoComplete="postal-code"
              />
              <button
                type="submit"
                disabled={busy}
                className="px-3 py-1 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? '…' : 'Save'}
              </button>
            </div>
          </form>

          {error && (
            <div className="text-[11px] text-red-400" role="alert">
              {error}
            </div>
          )}

          <div className="text-[10px] text-gray-500 pt-1 border-t border-gray-800">
            Coverage: MN, WI, IL, IN, MI, OH, PA, NY
          </div>
        </div>
      )}
    </div>
  );
}
