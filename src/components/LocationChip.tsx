'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  clearUserLocation,
  setUserLocation,
  useUserLocation,
  type UserLocation,
} from '@/lib/userLocation';
import { COVERAGE, STATE_CENTERS, STATE_NAMES, STATE_VIEW_ZOOM } from '@/lib/coverage';
import { lookupZip, normalizeZip } from '@/lib/zipLookup';

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
  const [zipInput, setZipInput] = useState('');
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [search, setSearch] = useState('');
  const zipRequestRef = useRef(0);
  const reactId = useId();
  const inputId = `${reactId}-zip-input`;
  const errorId = `${reactId}-zip-error`;

  const selectedState = location?.state?.toUpperCase() ?? null;

  const filteredStates = useMemo(() => {
    if (!search.trim()) return COVERAGE;
    const q = search.trim().toLowerCase();
    return COVERAGE.filter((code) => {
      if (code.toLowerCase().includes(q)) return true;
      const name = STATE_NAMES[code];
      return name ? name.toLowerCase().includes(q) : false;
    });
  }, [search]);

  const handlePick = useCallback(
    (state: keyof typeof STATE_CENTERS) => {
      zipRequestRef.current++;
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
      setZipInput('');
      setZipError(null);
      setSearch('');
      onLocationChange?.({ state, lat: center.lat, lon: center.lon, zoom: STATE_VIEW_ZOOM });
    },
    [onLocationChange],
  );

  const handleClear = useCallback(() => {
    zipRequestRef.current++;
    clearUserLocation();
    setZipInput('');
    setZipError(null);
    setSearch('');
    onLocationChange?.(null);
  }, [onLocationChange]);

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
        setZipInput('');
        setSearch('');
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
    [zipInput, onLocationChange],
  );

  if (!hydrated) return null;

  const open = mode === 'expanded';
  const selectedZip = typeof location?.zip === 'string' ? location.zip : null;
  const summary = selectedZip
    ? `${selectedZip} · ${selectedState ?? ''}`
    : (selectedState ?? 'All states');

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

          <div className="grid grid-cols-7 gap-1">
            {filteredStates.map((state) => {
              const active = selectedState === state;
              return (
                <button
                  key={state}
                  type="button"
                  onClick={() => handlePick(state)}
                  aria-pressed={active}
                  title={STATE_NAMES[state]}
                  className={`px-1 py-1 rounded font-mono text-xs font-semibold transition-colors ${
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

          {filteredStates.length === 0 && (
            <div className="text-[11px] text-gray-500 text-center py-1">No matches</div>
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
