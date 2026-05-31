'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  clearUserLocation,
  setUserLocation,
  useUserLocation,
  type UserLocation,
} from '@/lib/userLocation';
import { COVERAGE, STATE_CENTERS, STATE_NAMES, STATE_VIEW_ZOOM } from '@/lib/coverage';
import { OFFSHORE, REGIONS, regionForCode, statesByName, type RegionId } from '@/lib/regions';
import { lookupZip, normalizeZip } from '@/lib/zipLookup';
import UsRegionMap, { RegionStateMap, REGION_THEME } from './UsRegionMap';

const ZIP_VIEW_ZOOM = 8;

type Mode = 'collapsed' | 'expanded';

interface LocationChipProps {
  onLocationChange?: (
    next: { state: string; lat: number; lon: number; zoom?: number } | null,
  ) => void;
}

export default function LocationChip({ onLocationChange }: LocationChipProps) {
  const { location, hydrated } = useUserLocation();
  const [mode, setMode] = useState<Mode>('collapsed');
  const [drillRegion, setDrillRegion] = useState<RegionId | null>(null);
  const [zipInput, setZipInput] = useState('');
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [search, setSearch] = useState('');
  const zipRequestRef = useRef(0);
  const reactId = useId();
  const inputId = `${reactId}-zip-input`;
  const errorId = `${reactId}-zip-error`;

  const selectedState = location?.state?.toUpperCase() ?? null;
  const activeRegion = selectedState ? (regionForCode(selectedState)?.id ?? null) : null;

  const searching = search.trim().length > 0;
  const searchResults = useMemo(() => {
    if (!searching) return [];
    const q = search.trim().toLowerCase();
    return COVERAGE.filter((code) => {
      if (code.toLowerCase().includes(q)) return true;
      const name = STATE_NAMES[code];
      return name ? name.toLowerCase().includes(q) : false;
    });
  }, [search, searching]);

  const resetTransient = useCallback(() => {
    setDrillRegion(null);
    setZipInput('');
    setZipError(null);
    setSearch('');
  }, []);

  const handlePick = useCallback(
    (state: string) => {
      zipRequestRef.current++;
      const center = STATE_CENTERS[state];
      if (!center) return;
      const next: UserLocation = {
        state,
        lat: center.lat,
        lon: center.lon,
        source: 'manual',
        setAt: Date.now(),
      };
      setUserLocation(next);
      setMode('collapsed');
      resetTransient();
      onLocationChange?.({ state, lat: center.lat, lon: center.lon, zoom: STATE_VIEW_ZOOM });
    },
    [onLocationChange, resetTransient],
  );

  const handleClear = useCallback(() => {
    zipRequestRef.current++;
    clearUserLocation();
    resetTransient();
    onLocationChange?.(null);
  }, [onLocationChange, resetTransient]);

  const handleZipSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const normalized = normalizeZip(zipInput);
      if (!normalized) {
        setZipError('Enter a 5-digit ZIP.');
        return;
      }
      const requestId = ++zipRequestRef.current;
      setZipBusy(true);
      setZipError(null);
      try {
        const record = await lookupZip(normalized);
        if (requestId !== zipRequestRef.current) return;
        if (!record) {
          setZipError(`${normalized} isn't in our coverage area.`);
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
        resetTransient();
        onLocationChange?.({
          state: record.state,
          lat: record.lat,
          lon: record.lon,
          zoom: ZIP_VIEW_ZOOM,
        });
      } catch {
        if (requestId !== zipRequestRef.current) return;
        setZipError("Couldn't load the ZIP table. Try again in a moment.");
      } finally {
        if (requestId === zipRequestRef.current) setZipBusy(false);
      }
    },
    [zipInput, onLocationChange, resetTransient],
  );

  if (!hydrated) return null;

  const open = mode === 'expanded';
  const selectedZip = typeof location?.zip === 'string' ? location.zip : null;
  const summary = selectedZip
    ? `${selectedZip} · ${selectedState ?? ''}`
    : (selectedState ?? 'All states');

  const drilled = drillRegion ? REGIONS.find((r) => r.id === drillRegion) : null;

  return (
    <div
      className={`bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 text-xs overflow-hidden max-w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] ${
        open ? 'w-72' : 'w-fit'
      }`}
      role="region"
      aria-label="Location filter"
    >
      <button
        type="button"
        onClick={() => {
          if (open) resetTransient();
          setMode(open ? 'collapsed' : 'expanded');
        }}
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
        <div
          id="location-chip-body"
          className="px-3 pb-3 pt-1 space-y-2 max-h-[60vh] overflow-y-auto"
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search state or code…"
            className="w-full bg-gray-800 text-white px-2 py-1 rounded text-xs placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          {searching ? (
            <StateList
              codes={searchResults}
              selectedState={selectedState}
              onPick={handlePick}
              emptyLabel="No matches"
            />
          ) : drilled ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setDrillRegion(null)}
                className="flex items-center gap-2 w-full text-left group"
              >
                <span aria-hidden="true" className="text-gray-400 group-hover:text-white">
                  ‹
                </span>
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: REGION_THEME[drilled.id] }}
                />
                <span className="font-semibold text-white shrink-0 whitespace-nowrap">
                  {drilled.label}
                </span>
                <span className="text-gray-500 truncate min-w-0">· {drilled.blurb}</span>
                <span className="sr-only">Back to regions</span>
              </button>
              <RegionStateMap
                active={open}
                region={drilled.id}
                selectedState={selectedState}
                onPick={handlePick}
              />
              <StateList
                codes={statesByName(drilled.members)}
                selectedState={selectedState}
                onPick={handlePick}
                pulse
                accent={REGION_THEME[drilled.id]}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <UsRegionMap
                active={open}
                activeRegion={activeRegion}
                onPickRegion={(id) => setDrillRegion(id)}
              />
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wide text-gray-500">
                  Islands &amp; territories
                </p>
                <div className="flex flex-wrap gap-1">
                  {OFFSHORE.map((code) => {
                    const active = selectedState === code;
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => handlePick(code)}
                        aria-pressed={active}
                        aria-label={STATE_NAMES[code]}
                        className={`px-1.5 py-1 rounded font-mono text-[11px] font-semibold transition-colors ${
                          active
                            ? 'bg-blue-600 text-white hover:bg-blue-500'
                            : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                        }`}
                      >
                        {code}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleZipSubmit} className="space-y-1 pt-1 border-t border-gray-800">
            <label htmlFor={inputId} className="text-[11px] text-gray-400">
              Or enter your ZIP:
            </label>
            <div className="flex gap-1">
              <input
                id={inputId}
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
                aria-invalid={zipError !== null || undefined}
                aria-describedby={zipError ? errorId : undefined}
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
              <p id={errorId} role="alert" className="text-[10px] text-red-400">
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
        </div>
      )}
    </div>
  );
}

interface StateListProps {
  codes: ReadonlyArray<string>;
  selectedState: string | null;
  onPick: (code: string) => void;
  emptyLabel?: string;
  /** Pulse the rows to nudge a selection (drill-down leaf only, not search). */
  pulse?: boolean;
  /** Region accent colour the pulse glows in. */
  accent?: string;
}

/** Vertical list of large code + full-name buttons — the drill-down leaf. */
function StateList({ codes, selectedState, onPick, emptyLabel, pulse, accent }: StateListProps) {
  if (codes.length === 0) {
    return (
      <div className="text-[11px] text-gray-500 text-center py-2">{emptyLabel ?? 'No matches'}</div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {codes.map((code, i) => {
        const active = selectedState === code;
        // Already-chosen rows don't nag; everything else in a drilled region
        // pulses, staggered top-to-bottom so it ripples.
        const pulsing = pulse && !active;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onPick(code)}
            aria-pressed={active}
            aria-label={STATE_NAMES[code] ?? code}
            style={
              pulsing && accent
                ? ({ '--ss-pulse': accent, animationDelay: `${i * 110}ms` } as React.CSSProperties)
                : undefined
            }
            className={`flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors ${
              pulsing ? 'ss-pulse ' : ''
            }${active ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-800 hover:bg-gray-700'}`}
          >
            <span
              className={`font-mono text-xs font-bold w-7 shrink-0 ${
                active ? 'text-white' : 'text-gray-100'
              }`}
            >
              {code}
            </span>
            <span className={`text-xs truncate ${active ? 'text-blue-50' : 'text-gray-300'}`}>
              {STATE_NAMES[code] ?? code}
            </span>
          </button>
        );
      })}
    </div>
  );
}
