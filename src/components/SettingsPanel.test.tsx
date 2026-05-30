import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsPanel from './SettingsPanel';
import { PREFERENCES_KEY, __resetPreferencesForTests } from '@/lib/preferences';

describe('SettingsPanel — colorblind toggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetPreferencesForTests();
  });
  afterEach(() => {
    window.localStorage.clear();
    __resetPreferencesForTests();
  });

  it('renders the switch unchecked by default', () => {
    render(<SettingsPanel />);
    const sw = screen.getByRole('switch', { name: /colorblind-friendly colors/i });
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles the mode on and persists it', () => {
    render(<SettingsPanel />);
    const sw = screen.getByRole('switch', { name: /colorblind-friendly colors/i });
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(window.localStorage.getItem(PREFERENCES_KEY)).toContain('cbFriendly');
  });

  it('reflects a pre-existing stored value on mount', () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ colorVisionMode: 'cbFriendly' }));
    __resetPreferencesForTests();
    render(<SettingsPanel />);
    expect(
      screen.getByRole('switch', { name: /colorblind-friendly colors/i }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});
