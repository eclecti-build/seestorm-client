'use client';

// LocationChip — compact collapsible state picker below AlertsPanel.
// Styled like MapLegend: one-line collapsed header + expandable body.
// Clicking a state scopes the alerts list + map to that state via the
// existing `userState` filter wired through WeatherMap.
//
// This replaces the pre-2026-04-18 ZIP-entry flow. The underlying
// `userLocation.ts` store kept ZIP support as optional so legacy saves
// still hydrate correctly — we just render from `location.state` now.
// A future county- or ZIP-precision scope can reintroduce ZIP entry
// alongside this picker without re-touching persistence.
//
// Two visual states (no dismiss — MapLegend follows the same always-
// visible rule, and the collapsed chip is one line):
//   1. Collapsed — `LOCATION  All states ▸` or `LOCATION  WI ▸`.
//   2. Expanded  — 8-button grid for MN / WI / IL / IN / MI / OH / PA / NY,
//                  plus a "Show all states" action when a state is selected.

import { useCallback, useState } from 'react';
import {
  clearUserLocation,
  setUserLocation,
  useUserLocation,
  type UserLocation,
} from '@/lib/userLocation';
import { COVERAGE, STATE_CENTERS, STATE_VIEW_ZOOM } from '@/lib/coverage';
import { lookupZip, normalizeZip } from '@/lib/zipLookup';

// Zoom hydrated for a ZIP-precise pick — closer than the state-pick default
// so the user sees the area around their actual coordinates instead of the
// whole state.
const ZIP_VIEW_ZOOM = 8;

type Mode = 'collapsed' | 'expanded';

interface LocationChipProps {
  /**
   * Fired whenever the saved location changes (set or cleared). Passes an
   * optional `zoom` hint so WeatherMap can pick an appropriate fly-to zoom
   * for state-level picks (≈ 6) vs. legacy ZIP picks (≈ 8).
   */
  onLocationChange?: (
    next: { state: string; lat: number; lon: number; zoom?: number } | null,
  ) => void;
}

export default function LocationChip({ onLocationChange }: LocationChipProps) {
  const { location, hydrated } = useUserLocation();
  const [mode, setMode] = useState<Mode>('collapsed');
  // ZIP entry UI state — kept local because it's transient between
  // keystrokes and not worth persisting. `zipError` displays the most recent
  // failure (out-of-coverage / malformed / fetch failure).
  const [zipInput, setZipInput] = useState('');
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipBusy, setZipBusy] = useState(false);

  const handlePick = useCallback(
    (state: keyof typeof STATE_CENTERS) => {
      const center = STATE_CENTERS[state];
      const next: UserLocation = {
        state,
        lat: center.lat,
        lon: center.lon,
        source: 'manual',
        setAt: Date.now(),
      };
      // Note: no `zip` field. WeatherMap reads the absence of `zip` as
      // "state-picker mode" and applies the coarse userState filter rather
      // than the polygon-precise userPoint filter.
      setUserLocation(next);
      setMode('collapsed');
      onLocationChange?.({ state, lat: center.lat, lon: center.lon, zoom: STATE_VIEW_ZOOM });
    },
    [onLocationChange],
  );

  const handleClear = useCallback(() => {
    clearUserLocation();
    setZipInput('');
    setZipError(null);
    onLocationChange?.(null);
  }, [onLocationChange]);

  // Resolve the typed ZIP and persist as a ZIP-precise location. Failure
  // modes surface in `zipError` and don't clobber any previously-saved
  // location — only a successful lookup overwrites.
  const handleZipSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeZip(zipInput);
      if (!normalized) {
        setZipError('Enter a 5-digit ZIP.');
        return;
      }
      setZipBusy(true);
      setZipError(null);
      try {
        const record = await lookupZip(normalized);
        if (!record) {
          setZipError(`${normalized} isn't in our coverage area (MN/WI/IL/IN/MI/OH/PA/NY).`);
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
        setZipInput('');
        onLocationChange?.({
          state: record.state,
          lat: record.lat,
          lon: record.lon,
          zoom: ZIP_VIEW_ZOOM,
        });
      } catch {
        // lookupZip clears its own promise cache on rejection so the next
        // submit retries cleanly. Surface a friendly message rather than
        // exposing the underlying fetch error.
        setZipError("Couldn't load the ZIP table. Try again in a moment.");
      } finally {
        setZipBusy(false);
      }
    },
    [zipInput, onLocationChange],
  );

  // Render nothing until hydration finishes to avoid SSR/CSR mismatch from
  // the localStorage read in useUserLocation.
  if (!hydrated) return null;

  const open = mode === 'expanded';
  const selectedState = location?.state?.toUpperCase() ?? null;
  const selectedZip = typeof location?.zip === 'string' ? location.zip : null;
  // Summary leads with ZIP when present (more specific than state) so the
  // user immediately recognizes "I'm filtered to my own ZIP" vs the broader
  // statewide pick.
  const summary = selectedZip
    ? `${selectedZip} · ${selectedState ?? ''}`
    : (selectedState ?? 'All states');

  return (
    <div
      className="bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 text-xs overflow-hidden max-w-[18rem]"
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
          <div className="text-[11px] text-gray-400">Pick your state to scope the alerts list.</div>

          <div className="grid grid-cols-4 gap-1">
            {COVERAGE.map((state) => {
              const active = selectedState === state;
              return (
                <button
                  key={state}
                  type="button"
                  onClick={() => handlePick(state)}
                  aria-pressed={active}
                  className={`px-2 py-1.5 rounded font-mono text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-blue-600 text-white hover:bg-blue-500'
                      : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                  }`}
                >
                  {state}
                </button>
              );
            })}
          </div>

          {/* ZIP entry — sits below the state grid as the precise option.
             Submitting overrides any state pick with the ZIP-precise location;
             the userPoint filter (polygon point-in-polygon) takes over for
             warning-class alerts while zone-only alerts still flow through
             the state-level fallback so Watches stay visible. */}
          <form onSubmit={handleZipSubmit} className="space-y-1 pt-1 border-t border-gray-800">
            <label className="text-[11px] text-gray-400">
              Or enter your ZIP for alerts at your location:
            </label>
            <div className="flex gap-1">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9-]*"
                maxLength={10}
                value={zipInput}
                onChange={(e) => {
                  setZipInput(e.target.value);
                  if (zipError) setZipError(null);
                }}
                placeholder="54481"
                aria-label="ZIP code"
                disabled={zipBusy}
                className="flex-1 min-w-0 bg-gray-800 text-white px-2 py-1 rounded font-mono text-xs placeholder:text-gray-500 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={zipBusy || zipInput.trim().length === 0}
                className="px-2 py-1 rounded font-mono text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:hover:bg-blue-600"
              >
                {zipBusy ? '…' : 'Set'}
              </button>
            </div>
            {zipError && (
              <p role="alert" className="text-[10px] text-red-400">
                {zipError}
              </p>
            )}
          </form>

          {(selectedState || selectedZip) && (
            <button
              type="button"
              onClick={handleClear}
              className="w-full text-[11px] text-gray-400 hover:text-white underline-offset-2 hover:underline text-left"
            >
              Show all states
            </button>
          )}

          <div className="text-[10px] text-gray-500 pt-1 border-t border-gray-800">
            Coverage: MN, WI, IL, IN, MI, OH, PA, NY
          </div>
        </div>
      )}
    </div>
  );
}
