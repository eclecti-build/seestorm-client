// User location personalization — read/write a single saved location to
// localStorage so the map can default to the user's area on next visit and
// alerts can be filtered to their state.
//
// Kept dependency-free (no React, no fetch) so it can be called from both
// component init paths and the LocationBanner without circular imports.
//
// SSR safety: every reader checks for `window` before touching localStorage.
// The exported `useUserLocation()` hook returns `{location: null, hydrated:
// false}` on the server, then flips to the persisted value on first client
// effect — callers can render a stable shell first and only show
// location-specific UI once `hydrated` is true.

import { useEffect, useState } from 'react';

export const USER_LOCATION_KEY = 'seestorm:user-location';

export type UserLocationSource = 'manual' | 'geo' | 'ip';

export interface UserLocation {
  zip: string;
  state: string;
  lat: number;
  lon: number;
  source: UserLocationSource;
  /** Epoch ms — stored so we can later expire stale geo/ip-derived locations. */
  setAt: number;
}

function isUserLocation(value: unknown): value is UserLocation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.zip === 'string' &&
    typeof v.state === 'string' &&
    typeof v.lat === 'number' &&
    typeof v.lon === 'number' &&
    (v.source === 'manual' || v.source === 'geo' || v.source === 'ip') &&
    typeof v.setAt === 'number'
  );
}

/**
 * Read the saved location from localStorage. Returns null when:
 *  - we're on the server (no localStorage)
 *  - nothing has been saved
 *  - the stored value is malformed (so a partial/older shape doesn't crash UI)
 */
export function getUserLocation(): UserLocation | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(USER_LOCATION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUserLocation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setUserLocation(location: UserLocation): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(USER_LOCATION_KEY, JSON.stringify(location));
    // Custom event so components in the same tab can react without polling.
    window.dispatchEvent(new CustomEvent('seestorm:user-location-changed'));
  } catch {
    // localStorage can throw in private mode / quota — silently ignore;
    // worst case the user just doesn't get persistence this session.
  }
}

export function clearUserLocation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(USER_LOCATION_KEY);
    window.dispatchEvent(new CustomEvent('seestorm:user-location-changed'));
  } catch {
    // see setUserLocation
  }
}

/**
 * Hook for components that need to react to the saved location.
 *
 * `hydrated` starts false and flips to true after the first client-side
 * effect — use it to gate any render that would mismatch SSR (e.g. "show ZIP
 * chip" vs "show prompt"). This avoids React hydration warnings caused by
 * reading localStorage during render.
 */
export function useUserLocation(): { location: UserLocation | null; hydrated: boolean } {
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // SSR hydration: localStorage is only available client-side, so we *must*
    // setState here (post-mount) to surface the persisted value. This is the
    // canonical pattern for hydrating from a browser-only store; the lint
    // disable is intentional and narrowly scoped.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration from localStorage
    setLocation(getUserLocation());
    setHydrated(true);

    const onChange = () => setLocation(getUserLocation());
    window.addEventListener('seestorm:user-location-changed', onChange);
    // Also pick up changes made in OTHER tabs.
    window.addEventListener('storage', (e) => {
      if (e.key === USER_LOCATION_KEY) onChange();
    });
    return () => {
      window.removeEventListener('seestorm:user-location-changed', onChange);
    };
  }, []);

  return { location, hydrated };
}
