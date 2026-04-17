'use client';

// LocationBanner — small dismissible UI above the map that lets users set a
// home ZIP. With a ZIP saved, the alerts list is filtered to the user's state
// (cross-border alerts still surface) and the map opens centered on their
// area on next visit.
//
// Three visual states:
//   1. Dismissed — null (renders nothing). Persists across reloads.
//   2. Prompt   — input + buttons, shown until the user sets a ZIP or dismisses.
//   3. Chip     — shows the saved ZIP, clicking flips back to the prompt
//                  pre-filled with the current ZIP for editing.
//
// All persistence flows through `userLocation.ts` so the WeatherMap and any
// future surface (e.g. mobile drawer) stay in sync via the storage event.

import { useCallback, useEffect, useState } from 'react';
import {
  clearUserLocation,
  setUserLocation,
  useUserLocation,
  type UserLocation,
} from '@/lib/userLocation';
import { lookupZip, normalizeZip } from '@/lib/zipLookup';

const DISMISS_KEY = 'seestorm:location-banner-dismissed';

type Mode = 'prompt' | 'chip' | 'dismissed';

interface LocationBannerProps {
  /**
   * Fired whenever the saved location changes (set or cleared). Keeps the
   * map's userState filter in sync without requiring the parent to
   * subscribe to localStorage events itself.
   */
  onLocationChange?: (next: { state: string; lat: number; lon: number } | null) => void;
}

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(DISMISS_KEY, '1');
    else window.localStorage.removeItem(DISMISS_KEY);
  } catch {
    // ignore quota / private mode failures
  }
}

export default function LocationBanner({ onLocationChange }: LocationBannerProps) {
  const { location, hydrated } = useUserLocation();
  const [mode, setMode] = useState<Mode>('prompt');
  const [zipInput, setZipInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Once hydration completes, pick the right initial mode without fighting
  // SSR. Order matters: a saved location wins over a prior dismissal so the
  // user always sees their chip after setting one.
  useEffect(() => {
    if (!hydrated) return;
    if (location) {
      setMode('chip');
      setZipInput(location.zip);
    } else if (readDismissed()) {
      setMode('dismissed');
    } else {
      setMode('prompt');
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
        // Banner persists going forward — clear any prior dismissal so the
        // chip is visible after they set a location.
        writeDismissed(false);
        setMode('chip');
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

  const handleDismiss = useCallback(() => {
    writeDismissed(true);
    setMode('dismissed');
  }, []);

  const handleClear = useCallback(() => {
    clearUserLocation();
    setZipInput('');
    setMode('prompt');
    onLocationChange?.(null);
  }, [onLocationChange]);

  // Render nothing until hydration finishes (avoids SSR/CSR mismatch from
  // localStorage reads) and nothing when dismissed.
  if (!hydrated || mode === 'dismissed') return null;

  return (
    <div className="absolute top-4 right-4 z-10 max-w-sm">
      {mode === 'chip' && location ? (
        <div className="flex items-center gap-2 bg-gray-900/90 text-white text-xs rounded-lg shadow-lg border border-gray-700 px-3 py-2">
          <span className="text-gray-400">Showing alerts near</span>
          <button
            type="button"
            onClick={() => setMode('prompt')}
            className="font-mono font-semibold text-white hover:text-blue-300"
            aria-label={`Edit ZIP ${location.zip}`}
            title="Edit ZIP"
          >
            {location.zip}
          </button>
          <span className="text-gray-500">·</span>
          <span className="text-gray-300">{location.state}</span>
          <button
            type="button"
            onClick={handleClear}
            className="ml-1 text-gray-500 hover:text-white"
            aria-label="Clear saved location"
            title="Clear"
          >
            ×
          </button>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="bg-gray-900/95 text-white rounded-lg shadow-xl border border-gray-700 p-3"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <label htmlFor="zip-input" className="text-xs text-gray-300">
              See alerts near you. Enter your ZIP:
            </label>
            <button
              type="button"
              onClick={handleDismiss}
              className="text-gray-500 hover:text-white text-xs leading-none"
              aria-label="Dismiss location prompt"
              title="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="zip-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              value={zipInput}
              onChange={(e) => setZipInput(e.target.value)}
              placeholder="53703"
              className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              aria-invalid={error !== null}
              autoComplete="postal-code"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Looking up…' : 'Save'}
            </button>
          </div>
          {error && (
            <div className="mt-2 text-xs text-red-400" role="alert">
              {error}
            </div>
          )}
          <div className="mt-1 text-[10px] text-gray-500">
            Coverage: MN, WI, IL, IN, MI, OH, PA, NY
          </div>
        </form>
      )}
    </div>
  );
}
