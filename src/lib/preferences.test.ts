import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREFERENCES_KEY,
  getPreferences,
  setColorVisionMode,
  subscribePreferences,
  __resetPreferencesForTests,
} from './preferences';

describe('preferences store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetPreferencesForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    __resetPreferencesForTests();
  });

  it('defaults to "default" when nothing is stored', () => {
    expect(getPreferences().colorVisionMode).toBe('default');
  });

  it('round-trips a set value through localStorage', () => {
    setColorVisionMode('cbFriendly');
    expect(getPreferences().colorVisionMode).toBe('cbFriendly');
    expect(window.localStorage.getItem(PREFERENCES_KEY)).toContain('cbFriendly');
  });

  it('coerces garbage JSON to the default', () => {
    window.localStorage.setItem(PREFERENCES_KEY, 'not json{');
    __resetPreferencesForTests();
    expect(getPreferences().colorVisionMode).toBe('default');
  });

  it('coerces an unknown mode value to the default', () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ colorVisionMode: 'bogus' }));
    __resetPreferencesForTests();
    expect(getPreferences().colorVisionMode).toBe('default');
  });

  it('notifies subscribers on change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePreferences(listener);
    setColorVisionMode('cbFriendly');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setColorVisionMode('default');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('responds to a storage event from another tab', () => {
    setColorVisionMode('cbFriendly'); // prime the cache
    const listener = vi.fn();
    subscribePreferences(listener);
    // Simulate another tab writing the preference, then the browser's storage event:
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ colorVisionMode: 'default' }));
    window.dispatchEvent(new StorageEvent('storage', { key: PREFERENCES_KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPreferences().colorVisionMode).toBe('default');
  });
});
