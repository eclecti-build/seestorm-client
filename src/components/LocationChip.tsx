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
      setUserLocation(next);
      setMode('collapsed');
      onLocationChange?.({ state, lat: center.lat, lon: center.lon, zoom: STATE_VIEW_ZOOM });
    },
    [onLocationChange],
  );

  const handleClear = useCallback(() => {
    clearUserLocation();
    onLocationChange?.(null);
  }, [onLocationChange]);

  // Render nothing until hydration finishes to avoid SSR/CSR mismatch from
  // the localStorage read in useUserLocation.
  if (!hydrated) return null;

  const open = mode === 'expanded';
  const selectedState = location?.state?.toUpperCase() ?? null;
  const summary = selectedState ?? 'All states';

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

          {selectedState && (
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
