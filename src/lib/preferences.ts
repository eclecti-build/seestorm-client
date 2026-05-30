'use client';

// User preferences — currently just the color-vision mode. Mirrors the
// userLocation.ts persistence idiom (localStorage, SSR-guarded, garbage-safe)
// and the snapshotStore.ts subscription idiom (useSyncExternalStore with a
// cached snapshot reference so React never loops). Default is 'default' so an
// unset user sees today's app unchanged.

import { useSyncExternalStore } from 'react';
import type { ColorVisionMode } from './colorVisionMode';

export const PREFERENCES_KEY = 'seestorm:preferences';

export interface Preferences {
  colorVisionMode: ColorVisionMode;
}

const DEFAULT_PREFERENCES: Preferences = { colorVisionMode: 'default' };

function isColorVisionMode(v: unknown): v is ColorVisionMode {
  return v === 'default' || v === 'cbFriendly';
}

function readFromStorage(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREFERENCES;
    const mode = (parsed as Record<string, unknown>).colorVisionMode;
    return { colorVisionMode: isColorVisionMode(mode) ? mode : 'default' };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

// Cached snapshot. `useSyncExternalStore` requires getSnapshot to return a
// stable reference between renders unless the value actually changed. null =
// not yet hydrated from localStorage.
let cache: Preferences | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function refreshFromStorage(): void {
  const next = readFromStorage();
  if (cache !== null && next.colorVisionMode === cache.colorVisionMode) return;
  cache = next;
  emit();
}

let wired = false;
let storageHandler: ((e: StorageEvent) => void) | null = null;
function ensureWired(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  // Cross-tab: the browser fires 'storage' in OTHER tabs only.
  storageHandler = (e) => {
    if (e.key === PREFERENCES_KEY) refreshFromStorage();
  };
  window.addEventListener('storage', storageHandler);
}

export function getPreferences(): Preferences {
  if (cache === null) cache = readFromStorage();
  return cache;
}

export function setColorVisionMode(mode: ColorVisionMode): void {
  const next: Preferences = { colorVisionMode: mode };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
    } catch {
      // private mode / quota — accept loss of persistence this session.
    }
  }
  if (cache !== null && cache.colorVisionMode === mode) return;
  cache = next;
  emit();
}

export function subscribePreferences(listener: () => void): () => void {
  ensureWired();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerSnapshot(): Preferences {
  return DEFAULT_PREFERENCES;
}

/** React hook returning the current color-vision mode, reactive to changes. */
export function useColorVisionMode(): ColorVisionMode {
  return useSyncExternalStore(subscribePreferences, getPreferences, getServerSnapshot)
    .colorVisionMode;
}

/** Test-only reset. */
export function __resetPreferencesForTests(): void {
  if (typeof window !== 'undefined' && storageHandler) {
    window.removeEventListener('storage', storageHandler);
  }
  storageHandler = null;
  wired = false;
  cache = null;
  listeners.clear();
}
