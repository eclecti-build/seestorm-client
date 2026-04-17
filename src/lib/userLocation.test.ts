import { describe, it, expect, beforeEach } from 'vitest';
import {
  USER_LOCATION_KEY,
  clearUserLocation,
  getUserLocation,
  setUserLocation,
  type UserLocation,
} from './userLocation';

const SAMPLE: UserLocation = {
  zip: '53703',
  state: 'WI',
  lat: 43.0747,
  lon: -89.3838,
  source: 'manual',
  setAt: 1_700_000_000_000,
};

describe('userLocation persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns null when nothing is saved', () => {
    expect(getUserLocation()).toBeNull();
  });

  it('round-trips a saved location', () => {
    setUserLocation(SAMPLE);
    expect(getUserLocation()).toEqual(SAMPLE);
  });

  it('clear removes the saved location', () => {
    setUserLocation(SAMPLE);
    clearUserLocation();
    expect(getUserLocation()).toBeNull();
  });

  it('returns null on malformed stored value', () => {
    window.localStorage.setItem(USER_LOCATION_KEY, '{not valid json');
    expect(getUserLocation()).toBeNull();
  });

  it('returns null on partially-valid shape (defends against schema drift)', () => {
    window.localStorage.setItem(USER_LOCATION_KEY, JSON.stringify({ zip: '53703', state: 'WI' }));
    expect(getUserLocation()).toBeNull();
  });
});
