# Colorblind-Friendly Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Colorblind-friendly colors" setting to the SeeStorm client that swaps the alert/tornado/radar palette for a CVD-safe one, with the default look unchanged for anyone who never opts in.

**Architecture:** A localStorage-backed preferences store (`useSyncExternalStore`) holds `colorVisionMode`. Parallel CVD-safe palette constants live beside the existing ones in `alerts.ts`/`tornado.ts`, exposed through mode-aware selectors. The map builds its `fill-color`/`line-color` from mode-aware MapLibre `match` expressions (keyed on stable feature fields, never baked hex) and recolors radar via native `raster-hue-rotate`/`-saturation`/`-contrast`; a gear-button settings panel flips the mode and every surface reacts live.

**Tech Stack:** Next.js 16 (static export), React 19, MapLibre GL, Tailwind 4, Vitest + Testing Library (jsdom).

---

## File Structure

**New files**
- `src/lib/colorVisionMode.ts` — the `ColorVisionMode` type only (pure, zero deps; avoids import cycles between the pure palette libs and the React store).
- `src/lib/preferences.ts` — localStorage + `useSyncExternalStore` preferences store and `useColorVisionMode()` hook.
- `src/lib/preferences.test.ts`
- `src/lib/alertPaint.ts` — pure builders that return MapLibre `match` expressions as plain arrays (no `maplibre-gl` import, so they're unit-testable without WebGL).
- `src/lib/alertPaint.test.ts`
- `src/components/SettingsPanel.tsx` — the panel body: one accessible switch.
- `src/components/SettingsButton.tsx` — the gear trigger + popover (open/close, Esc, outside-click).
- `src/components/SettingsPanel.test.tsx`

**Modified files**
- `src/lib/alerts.ts` — add `WARNING_COLORS_CB`, `FALLBACK_COLOR_CB`, `warningColorsFor`, `fallbackColorFor`; make `colorForEvent` mode-aware.
- `src/lib/alerts.test.ts` — add CB + default-regression cases (create the file if it does not exist).
- `src/lib/tornado.ts` — add `TORNADO_CATEGORY_COLOR_CB`, `tornadoCategoryColorsFor`; make `tornadoColor` mode-aware.
- `src/lib/tornado.test.ts` — add CB + default-regression cases (create the file if it does not exist).
- `src/components/MapLegend.tsx` — read the active palette via `useColorVisionMode()`.
- `src/components/AlertsPanel.tsx` — compute swatch color via mode-aware selectors.
- `src/components/WeatherMap.tsx` — build color expressions from `alertPaint.ts`, add a mode-change effect (alerts, tornado, radar), and fix the popup color.
- `src/app/page.tsx` — mount `<SettingsButton />`.

---

## Task 1: `ColorVisionMode` type + preferences store

**Files:**
- Create: `src/lib/colorVisionMode.ts`
- Create: `src/lib/preferences.ts`
- Test: `src/lib/preferences.test.ts`

- [ ] **Step 1: Create the shared type**

`src/lib/colorVisionMode.ts`:

```ts
// The single color-vision setting. Lives in its own zero-dependency module so
// the pure palette libs (alerts.ts, tornado.ts) and the React preferences
// store can all import the type without creating an import cycle and without
// the pure libs pulling in React.
export type ColorVisionMode = 'default' | 'cbFriendly';
```

- [ ] **Step 2: Write the failing test**

`src/lib/preferences.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/lib/preferences.test.ts`
Expected: FAIL — `Cannot find module './preferences'`.

- [ ] **Step 4: Implement the store**

`src/lib/preferences.ts`:

```ts
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
function ensureWired(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  // Cross-tab: the browser fires 'storage' in OTHER tabs only.
  window.addEventListener('storage', (e) => {
    if (e.key === PREFERENCES_KEY) refreshFromStorage();
  });
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
  cache = null;
  listeners.clear();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/lib/preferences.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/colorVisionMode.ts src/lib/preferences.ts src/lib/preferences.test.ts
git commit -m "feat: add color-vision preferences store"
```

---

## Task 2: Mode-aware alert palette

**Files:**
- Modify: `src/lib/alerts.ts:20-89`
- Test: `src/lib/alerts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/alerts.test.ts` (create the file with this content if it does not exist):

```ts
import { describe, expect, it } from 'vitest';
import {
  WARNING_COLORS,
  FALLBACK_COLOR,
  colorForEvent,
  warningColorsFor,
  fallbackColorFor,
} from './alerts';

describe('colorForEvent — default mode (regression: must not change today’s look)', () => {
  it('returns the exact current hexes for default mode', () => {
    expect(colorForEvent('Tornado Warning')).toBe('#FF0000');
    expect(colorForEvent('Tornado Warning', 'default')).toBe('#FF0000');
    expect(colorForEvent('Severe Thunderstorm Warning', 'default')).toBe('#FFA500');
    expect(colorForEvent('Freeze Warning', 'default')).toBe('#483D8B');
  });
  it('falls back to the existing gray for unknown events in default mode', () => {
    expect(colorForEvent('Dust Storm Warning', 'default')).toBe(FALLBACK_COLOR);
  });
  it('warningColorsFor("default") is the canonical palette', () => {
    expect(warningColorsFor('default')).toBe(WARNING_COLORS);
  });
});

describe('colorForEvent — colorblind mode', () => {
  it('maps each family to its Okabe–Ito hue', () => {
    expect(colorForEvent('Tornado Warning', 'cbFriendly')).toBe('#D55E00');
    expect(colorForEvent('Tornado Watch', 'cbFriendly')).toBe('#D55E00');
    expect(colorForEvent('Severe Thunderstorm Warning', 'cbFriendly')).toBe('#E69F00');
    expect(colorForEvent('Flash Flood Warning', 'cbFriendly')).toBe('#0072B2');
    expect(colorForEvent('Flood Advisory', 'cbFriendly')).toBe('#56B4E9');
    expect(colorForEvent('Freeze Watch', 'cbFriendly')).toBe('#CC79A7');
    expect(colorForEvent('Special Weather Statement', 'cbFriendly')).toBe('#009E73');
  });
  it('uses the CB fallback for unknown events', () => {
    expect(colorForEvent('Dust Storm Warning', 'cbFriendly')).toBe(fallbackColorFor('cbFriendly'));
    expect(fallbackColorFor('cbFriendly')).toBe('#BBBBBB');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/alerts.test.ts`
Expected: FAIL — `warningColorsFor`/`fallbackColorFor` not exported; CB cases undefined.

- [ ] **Step 3: Implement the CB palette + mode-aware selectors**

In `src/lib/alerts.ts`, add the import near the top (after the existing imports, before the `// Palette` section):

```ts
import type { ColorVisionMode } from './colorVisionMode';
```

Immediately after the `FALLBACK_COLOR` declaration (currently `src/lib/alerts.ts:59`), add:

```ts
// Colorblind-safe palette (opt-in). One Okabe–Ito (color-universal) hue per
// product family; within-family Warning/Watch/Advisory stays encoded by the
// fill-opacity + dashed/solid stroke the map already applies, which is more
// robust for CVD than today's per-tier hue mix. Keyed by the same event
// strings as WARNING_COLORS so the selectors are symmetric.
export const WARNING_COLORS_CB: Record<string, string> = {
  'Tornado Warning': '#D55E00',
  'Tornado Watch': '#D55E00',
  'Severe Thunderstorm Warning': '#E69F00',
  'Severe Thunderstorm Watch': '#E69F00',
  'Flash Flood Warning': '#0072B2',
  'Flash Flood Watch': '#0072B2',
  'Flood Warning': '#56B4E9',
  'Flood Watch': '#56B4E9',
  'Flood Advisory': '#56B4E9',
  'Flood Statement': '#56B4E9',
  'Special Weather Statement': '#009E73',
  'Freeze Warning': '#CC79A7',
  'Freeze Watch': '#CC79A7',
};

export const FALLBACK_COLOR_CB = '#BBBBBB';

export function warningColorsFor(mode: ColorVisionMode): Record<string, string> {
  return mode === 'cbFriendly' ? WARNING_COLORS_CB : WARNING_COLORS;
}

export function fallbackColorFor(mode: ColorVisionMode): string {
  return mode === 'cbFriendly' ? FALLBACK_COLOR_CB : FALLBACK_COLOR;
}
```

Then replace the existing `colorForEvent` (currently `src/lib/alerts.ts:83-85`):

```ts
export function colorForEvent(event: string): string {
  return WARNING_COLORS[event] ?? FALLBACK_COLOR;
}
```

with:

```ts
export function colorForEvent(event: string, mode: ColorVisionMode = 'default'): string {
  return warningColorsFor(mode)[event] ?? fallbackColorFor(mode);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/alerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alerts.ts src/lib/alerts.test.ts
git commit -m "feat: add colorblind-safe alert palette and mode-aware colorForEvent"
```

---

## Task 3: Mode-aware tornado palette

**Files:**
- Modify: `src/lib/tornado.ts:69-78`
- Test: `src/lib/tornado.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/tornado.test.ts` (create the file with this content if it does not exist):

```ts
import { describe, expect, it } from 'vitest';
import {
  TORNADO_CATEGORY_COLOR,
  tornadoColor,
  tornadoCategoryColorsFor,
  type TornadoDetection,
} from './tornado';

const emergency: TornadoDetection = {
  detection: 'OBSERVED',
  confirmed: true,
  damage_threat: 'CATASTROPHIC',
};
const radarIndicated: TornadoDetection = {
  detection: 'RADAR_INDICATED',
  confirmed: false,
  damage_threat: 'BASE',
};

describe('tornadoColor — default mode (regression)', () => {
  it('returns the current ramp hexes', () => {
    expect(tornadoColor(radarIndicated)).toBe('#FF8C42');
    expect(tornadoColor(emergency)).toBe('#C026D3');
    expect(tornadoColor(emergency, 'default')).toBe('#C026D3');
  });
  it('tornadoCategoryColorsFor("default") is the canonical ramp', () => {
    expect(tornadoCategoryColorsFor('default')).toBe(TORNADO_CATEGORY_COLOR);
  });
});

describe('tornadoColor — colorblind mode', () => {
  it('returns the CB magenta brightness ramp', () => {
    expect(tornadoColor(radarIndicated, 'cbFriendly')).toBe('#B05CA8');
    expect(tornadoColor(emergency, 'cbFriendly')).toBe('#FF9EC4');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/tornado.test.ts`
Expected: FAIL — `tornadoCategoryColorsFor` not exported; CB cases undefined.

- [ ] **Step 3: Implement the CB ramp + mode-aware selector**

In `src/lib/tornado.ts`, add at the very top of the file (line 1, before the existing leading comment block is fine, but place after it for readability — anywhere above `tornadoColor`):

```ts
import type { ColorVisionMode } from './colorVisionMode';
```

After the `TORNADO_CATEGORY_COLOR` declaration (currently `src/lib/tornado.ts:69-74`), add:

```ts
// Colorblind-safe tornado ladder (opt-in). A single magenta family that
// climbs in brightness — on the dark basemap brighter reads as more severe,
// and the magenta region stays distinguishable across CVD types. The existing
// category-scaled halo width + confirmed pulse reinforce the escalation.
export const TORNADO_CATEGORY_COLOR_CB: Record<TornadoCategory, string> = {
  RADAR_INDICATED: '#B05CA8',
  CONFIRMED: '#D44FA0',
  PDS: '#F06595',
  EMERGENCY: '#FF9EC4',
};

export function tornadoCategoryColorsFor(mode: ColorVisionMode): Record<TornadoCategory, string> {
  return mode === 'cbFriendly' ? TORNADO_CATEGORY_COLOR_CB : TORNADO_CATEGORY_COLOR;
}
```

Then replace the existing `tornadoColor` (currently `src/lib/tornado.ts:76-78`):

```ts
export function tornadoColor(d: TornadoDetection): string {
  return TORNADO_CATEGORY_COLOR[tornadoCategory(d)];
}
```

with:

```ts
export function tornadoColor(d: TornadoDetection, mode: ColorVisionMode = 'default'): string {
  return tornadoCategoryColorsFor(mode)[tornadoCategory(d)];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/tornado.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tornado.ts src/lib/tornado.test.ts
git commit -m "feat: add colorblind-safe tornado ramp and mode-aware tornadoColor"
```

---

## Task 4: Map color expression builders (pure + tested)

**Files:**
- Create: `src/lib/alertPaint.ts`
- Test: `src/lib/alertPaint.test.ts`

This isolates the map's color logic into a pure module so the "default mode must equal today's map look" guarantee is locked by a unit test instead of by eyeballing the map.

- [ ] **Step 1: Write the failing test**

`src/lib/alertPaint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildEventColorExpression, buildTornadoColorExpression } from './alertPaint';

// This is the EXACT expression WeatherMap.tsx hardcoded before this change.
// Locking it guarantees default mode does not alter the map. Note: Freeze and
// Special Weather Statement are intentionally absent (they fall through to the
// gray fallback on the map today) — do not "fix" that here.
const LEGACY_EVENT_COLOR = [
  'match',
  ['get', 'event'],
  'Tornado Warning', '#FF0000',
  'Tornado Watch', '#FFFF00',
  'Severe Thunderstorm Warning', '#FFA500',
  'Severe Thunderstorm Watch', '#DB7093',
  'Flash Flood Warning', '#8B0000',
  'Flash Flood Watch', '#2E8B57',
  'Flood Warning', '#B22222',
  'Flood Watch', '#3CB371',
  'Flood Advisory', '#6CA6CD',
  'Flood Statement', '#6CA6CD',
  '#888888',
];

describe('buildEventColorExpression', () => {
  it('default mode reproduces the legacy expression byte-for-byte', () => {
    expect(buildEventColorExpression('default')).toEqual(LEGACY_EVENT_COLOR);
  });
  it('cbFriendly mode uses the CB palette and CB fallback', () => {
    const expr = buildEventColorExpression('cbFriendly');
    expect(expr[3]).toBe('#D55E00'); // Tornado Warning color (index after 'match', [get], 'Tornado Warning')
    expect(expr[expr.length - 1]).toBe('#BBBBBB'); // CB fallback
  });
});

describe('buildTornadoColorExpression', () => {
  it('default mode resolves categories to the current ramp', () => {
    expect(buildTornadoColorExpression('default')).toEqual([
      'match',
      ['get', 'tornadoCategory'],
      'RADAR_INDICATED', '#FF8C42',
      'CONFIRMED', '#FF1A1A',
      'PDS', '#B5002E',
      'EMERGENCY', '#C026D3',
      '#FF8C42',
    ]);
  });
  it('cbFriendly mode resolves categories to the CB ramp', () => {
    expect(buildTornadoColorExpression('cbFriendly')).toEqual([
      'match',
      ['get', 'tornadoCategory'],
      'RADAR_INDICATED', '#B05CA8',
      'CONFIRMED', '#D44FA0',
      'PDS', '#F06595',
      'EMERGENCY', '#FF9EC4',
      '#B05CA8',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/alertPaint.test.ts`
Expected: FAIL — `Cannot find module './alertPaint'`.

- [ ] **Step 3: Implement the builders**

`src/lib/alertPaint.ts`:

```ts
// Pure builders for the MapLibre 'match' color expressions used by WeatherMap.
// Kept free of any `maplibre-gl` import so they are unit-testable without a DOM
// or WebGL context. WeatherMap casts the returned arrays to ExpressionSpecification.
//
// IMPORTANT: the event ordering below intentionally omits Freeze* and Special
// Weather Statement. Those events fall through to the gray fallback on the MAP
// today (the legend/side-panel still color them via WARNING_COLORS). Preserving
// that exactly is what keeps default mode visually identical.

import type { ColorVisionMode } from './colorVisionMode';
import { warningColorsFor, fallbackColorFor } from './alerts';
import { tornadoCategoryColorsFor } from './tornado';

const EVENT_COLOR_ORDER = [
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Flash Flood Warning',
  'Flash Flood Watch',
  'Flood Warning',
  'Flood Watch',
  'Flood Advisory',
  'Flood Statement',
] as const;

export function buildEventColorExpression(mode: ColorVisionMode): unknown[] {
  const colors = warningColorsFor(mode);
  const cases: unknown[] = [];
  for (const event of EVENT_COLOR_ORDER) {
    cases.push(event, colors[event]);
  }
  return ['match', ['get', 'event'], ...cases, fallbackColorFor(mode)];
}

export function buildTornadoColorExpression(mode: ColorVisionMode): unknown[] {
  const c = tornadoCategoryColorsFor(mode);
  return [
    'match',
    ['get', 'tornadoCategory'],
    'RADAR_INDICATED', c.RADAR_INDICATED,
    'CONFIRMED', c.CONFIRMED,
    'PDS', c.PDS,
    'EMERGENCY', c.EMERGENCY,
    c.RADAR_INDICATED,
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/alertPaint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alertPaint.ts src/lib/alertPaint.test.ts
git commit -m "feat: add tested mode-aware map color expression builders"
```

---

## Task 5: Settings UI (gear button + panel + toggle)

**Files:**
- Create: `src/components/SettingsPanel.tsx`
- Create: `src/components/SettingsButton.tsx`
- Test: `src/components/SettingsPanel.test.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Write the failing test**

`src/components/SettingsPanel.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/SettingsPanel.test.tsx`
Expected: FAIL — `Cannot find module './SettingsPanel'`.

- [ ] **Step 3: Implement the panel**

`src/components/SettingsPanel.tsx`:

```tsx
'use client';

import { useColorVisionMode, setColorVisionMode } from '@/lib/preferences';

// The settings body. v1 carries exactly one control; it's a component of its
// own so it can be unit-tested in isolation and so the gear popover stays a
// thin shell. Future preferences slot in here.
export default function SettingsPanel() {
  const mode = useColorVisionMode();
  const on = mode === 'cbFriendly';

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">Accessibility</div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Colorblind-friendly colors"
        onClick={() => setColorVisionMode(on ? 'default' : 'cbFriendly')}
        className="w-full flex items-center gap-3 rounded px-1.5 py-1 text-left transition-colors cursor-pointer hover:bg-gray-800"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            on ? 'bg-emerald-500' : 'bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              on ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </span>
        <span className="flex-1 leading-tight">
          Colorblind-friendly colors
          <span className="block text-[10px] text-gray-400">
            Swaps alert, tornado &amp; radar colors for a CVD-safe palette
          </span>
        </span>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/SettingsPanel.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the gear button + popover**

`src/components/SettingsButton.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import SettingsPanel from './SettingsPanel';

// Gear control. Mounted as a fixed overlay (not a MapLibre IControl) so the
// React-controlled panel needs no portal. Bottom-right keeps it clear of the
// top-left alerts/legend column and the top-right MapLibre nav/geolocate
// controls. Placement is a known verify-time tunable.
export default function SettingsButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="fixed z-30 bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))]"
    >
      {open && (
        <div
          role="dialog"
          aria-label="Settings"
          className="absolute bottom-full right-0 mb-2 w-64 bg-gray-900/95 text-white text-xs rounded-lg shadow-xl border border-gray-700 p-3"
        >
          <SettingsPanel />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Settings"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-900/95 text-gray-200 shadow-xl border border-gray-700 hover:bg-gray-800 cursor-pointer"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M19.4 13a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7 19.3l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 13H4.5a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 6.7 6.13l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 11 3.6V3.5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 20.4 11h.1a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.01.99Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Mount it in the page**

In `src/app/page.tsx`, add the import after the `ChromeOverlay` import (line 4):

```tsx
import SettingsButton from '@/components/SettingsButton';
```

And render it after `<ChromeOverlay />` inside `<main>` (currently `src/app/page.tsx:19`):

```tsx
      <WeatherMap />
      <ChromeOverlay />
      <SettingsButton />
```

- [ ] **Step 7: Run the test suite + typecheck**

Run: `npm test -- src/components/SettingsPanel.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/SettingsPanel.tsx src/components/SettingsButton.tsx src/components/SettingsPanel.test.tsx src/app/page.tsx
git commit -m "feat: add settings gear with colorblind-mode toggle"
```

---

## Task 6: Wire MapLegend to the active palette

**Files:**
- Modify: `src/components/MapLegend.tsx:1-6, 132-148, 198-209, 398-407`

No new test — this is presentational wiring; the palette logic is already covered by Task 2/3 and the toggle by Task 5. Verified via typecheck/build + manual check.

- [ ] **Step 1: Update imports**

Replace the imports block (currently `src/components/MapLegend.tsx:3-6`):

```tsx
import { useState } from 'react';
import { WARNING_COLORS, tierForEvent, type AlertTier } from '@/lib/alerts';
import { AlertIcon } from '@/lib/alertIcons';
import { TORNADO_CATEGORY_COLOR, type TornadoCategory } from '@/lib/tornado';
```

with:

```tsx
import { useState } from 'react';
import { warningColorsFor, tierForEvent, type AlertTier } from '@/lib/alerts';
import { AlertIcon } from '@/lib/alertIcons';
import { tornadoCategoryColorsFor, type TornadoCategory } from '@/lib/tornado';
import { useColorVisionMode } from '@/lib/preferences';
```

- [ ] **Step 2: Delete the module-level `TIER_DESCRIPTIONS`**

Remove the constant currently at `src/components/MapLegend.tsx:132-148` (the `const TIER_DESCRIPTIONS: ReadonlyArray<...> = [ ... ];` block). It will be rebuilt per-render from the active palette inside the component (Step 4). Leave `TORNADO_STATUS_DESCRIPTIONS` as-is.

- [ ] **Step 3: Read the mode + active palettes at the top of the component**

At the start of the `MapLegend` component body (currently `src/components/MapLegend.tsx:206`, the `const [open, setOpen] = useState<boolean>(false);` line), add directly below it:

```tsx
  const mode = useColorVisionMode();
  const warningColors = warningColorsFor(mode);
  const tornadoColors = tornadoCategoryColorsFor(mode);

  const TIER_DESCRIPTIONS: ReadonlyArray<{ tier: AlertTier; color: string; label: string }> = [
    { tier: 'Warning', color: warningColors['Tornado Warning'], label: 'Warning — take action' },
    { tier: 'Watch', color: warningColors['Tornado Watch'], label: 'Watch — be aware' },
    {
      tier: 'Advisory',
      color: warningColors['Special Weather Statement'],
      label: 'Advisory — monitor',
    },
  ];
```

- [ ] **Step 4: Use the active palette for the per-event list**

Replace `const entries = Object.entries(WARNING_COLORS);` (currently `src/components/MapLegend.tsx:208`) with:

```tsx
  const entries = Object.entries(warningColors);
```

- [ ] **Step 5: Use the active tornado ramp in the status glyphs**

Replace `color={TORNADO_CATEGORY_COLOR[category]}` (currently `src/components/MapLegend.tsx:400`) with:

```tsx
                  <TornadoStatusGlyph color={tornadoColors[category]} pulse={pulse} />
```

(That is the full `<TornadoStatusGlyph ... />` element on that line — only the `color` prop changes.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `WARNING_COLORS` / `TORNADO_CATEGORY_COLOR` are now reported as unused, this confirms all references were replaced.)

- [ ] **Step 7: Commit**

```bash
git add src/components/MapLegend.tsx
git commit -m "feat: drive map legend swatches from the active color-vision palette"
```

---

## Task 7: Wire AlertsPanel + the map popup to the active palette

**Files:**
- Modify: `src/components/AlertsPanel.tsx:4-12, 51-67, ~145-149`
- Modify: `src/components/WeatherMap.tsx:1838-1840`

- [ ] **Step 1: Update AlertsPanel imports**

Replace the import block (currently `src/components/AlertsPanel.tsx:4-12`):

```tsx
import {
  colorForEvent,
  deriveMultiStateDisplay,
  groupByFamily,
  tierForEvent,
  type AlertFamily,
  type WeatherAlert,
} from '@/lib/alerts';
import { AlertIcon } from '@/lib/alertIcons';
```

with:

```tsx
import {
  colorForEvent,
  deriveMultiStateDisplay,
  groupByFamily,
  tierForEvent,
  type AlertFamily,
  type WeatherAlert,
} from '@/lib/alerts';
import { tornadoColor } from '@/lib/tornado';
import { useColorVisionMode } from '@/lib/preferences';
import { AlertIcon } from '@/lib/alertIcons';
```

- [ ] **Step 2: Make the AlertCard swatch mode-aware**

In `AlertCard`, replace the color line (currently `src/components/AlertsPanel.tsx:64-66`):

```tsx
  // Tornado alerts use the normalized category color (magenta ramp); all
  // other events fall back to the standard per-event palette.
  const color = alert.properties.tornadoColor ?? colorForEvent(alert.properties.event);
```

with:

```tsx
  // Tornado alerts use the normalized category color (magenta ramp); all
  // other events fall back to the standard per-event palette. Resolved from
  // the live color-vision mode (not the baked `tornadoColor` property, which
  // is always the default-palette hex) so colorblind mode recolors the panel.
  const mode = useColorVisionMode();
  const color = alert.properties.tornado
    ? tornadoColor(alert.properties.tornado, mode)
    : colorForEvent(alert.properties.event, mode);
```

- [ ] **Step 3: Make the FamilySection header color mode-aware**

Find the family-header color line (currently near `src/components/AlertsPanel.tsx:148`):

```tsx
  const color = colorForEvent(alerts[0]?.properties.event ?? '');
```

Replace it with:

```tsx
  const mode = useColorVisionMode();
  const color = colorForEvent(alerts[0]?.properties.event ?? '', mode);
```

(If a `mode` is already in scope in that component from another edit, do not declare it twice — reuse it.)

- [ ] **Step 4: Make the WeatherMap popup color mode-aware**

`WeatherMap.tsx` already has `colorVisionMode` in scope after Task 8; but this popup edit is independent, so read it from the same source. First ensure `tornadoColor` is imported (handled in Task 8 Step 1 — if doing Task 7 before Task 8, add `import { tornadoColor } from '@/lib/tornado';` to WeatherMap's imports).

Replace the popup color (currently `src/components/WeatherMap.tsx:1838-1840`):

```tsx
                  color:
                    selectedAlert.properties.tornadoColor ??
                    colorForEvent(selectedAlert.properties.event),
```

with:

```tsx
                  color: selectedAlert.properties.tornado
                    ? tornadoColor(selectedAlert.properties.tornado, colorVisionMode)
                    : colorForEvent(selectedAlert.properties.event, colorVisionMode),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: `colorVisionMode is not defined` in WeatherMap.tsx IF Task 8 has not run yet. That is expected — Task 8 introduces it. If you are running tasks in order, do Task 8 next and typecheck there. Otherwise, the AlertsPanel half should typecheck clean on its own.

- [ ] **Step 6: Commit**

```bash
git add src/components/AlertsPanel.tsx src/components/WeatherMap.tsx
git commit -m "feat: recolor alerts panel and map popup for color-vision mode"
```

---

## Task 8: Wire WeatherMap map layers + radar to the active palette

**Files:**
- Modify: `src/components/WeatherMap.tsx` — imports (~13-21), radar paint constants (after `RADAR_OPACITY_EXPR` ~66), init expressions (1059-1088, 1333-1336), mode ref + change effect.

- [ ] **Step 1: Update imports**

In the `@/lib/alerts` import group (currently `src/components/WeatherMap.tsx:13-21`, beginning with `WARNING_COLORS,` and `colorForEvent,`), remove `WARNING_COLORS,` (no longer referenced — the expression now comes from `alertPaint`) and keep `colorForEvent,`. Then add these imports below that group:

```tsx
import { tornadoColor } from '@/lib/tornado';
import { buildEventColorExpression, buildTornadoColorExpression } from '@/lib/alertPaint';
import { useColorVisionMode } from '@/lib/preferences';
```

- [ ] **Step 2: Add radar CB paint constants**

Immediately after the `RADAR_OPACITY_EXPR` declaration (currently ends `src/components/WeatherMap.tsx:66`), add:

```tsx
// Colorblind radar recolor, applied to both raster radar layers via native
// paint properties. Rotating green→blue and red→magenta + a small saturation/
// contrast bump opens a brightness gap between light rain and heavy cores for
// red-green vision. Default mode uses MapLibre's neutral defaults (no-op), so
// the radar is untouched unless the user opts in. Angle is a verify-time tunable.
const RADAR_CB_HUE_ROTATE = 100;
const RADAR_CB_SATURATION = 0.25;
const RADAR_CB_CONTRAST = 0.1;
```

- [ ] **Step 3: Read the mode + keep a ref for map init**

In the component body, near the other state (e.g. just after `const [mapReady, setMapReady] = useState<boolean>(false);` at `src/components/WeatherMap.tsx:202`), add:

```tsx
  const colorVisionMode = useColorVisionMode();
  // Init runs once; it reads the mode through a ref so a later mode change does
  // NOT re-run init (which would rebuild the whole map). Live updates are
  // handled by the dedicated effect below.
  const colorVisionModeRef = useRef(colorVisionMode);
  colorVisionModeRef.current = colorVisionMode;
```

- [ ] **Step 4: Build the init expressions from the active palette**

Replace the inline `eventColor` literal (currently `src/components/WeatherMap.tsx:1059-1088`, the whole `const eventColor: maplibregl.ExpressionSpecification = [ 'match', ... '#888888', ];`) with:

```tsx
      // Per-event color expression — reused across all six tier layers below.
      // Built from the active color-vision palette via the tested pure builder
      // (alertPaint.ts). Default mode reproduces the previous hardcoded
      // expression byte-for-byte. The mode-change effect below rebuilds this
      // when the user toggles colorblind mode.
      const eventColor = buildEventColorExpression(
        colorVisionModeRef.current,
      ) as maplibregl.ExpressionSpecification;
```

Replace the tornado color expression (currently `src/components/WeatherMap.tsx:1333-1336`):

```tsx
      const tornadoColorExpr = [
        'get',
        'tornadoColor',
      ] as unknown as maplibregl.ExpressionSpecification;
```

with:

```tsx
      // Drive tornado color from the category (a stable feature field) through
      // the active palette, NOT the baked `tornadoColor` property — so a mode
      // flip recolors the ramp without re-deriving features. In default mode
      // each category resolves to the same hex the baked property carried, so
      // the look is unchanged. The `['has','tornadoColor']` filters elsewhere
      // still rely on the baked property's presence and are untouched.
      const tornadoColorExpr = buildTornadoColorExpression(
        colorVisionModeRef.current,
      ) as maplibregl.ExpressionSpecification;
```

- [ ] **Step 5: Add the mode-change effect**

Add this effect immediately after the existing tornado-visibility effect that ends at `src/components/WeatherMap.tsx:921` (the one whose dep array is `[mapReady, isForecast, hiddenTiers, alertLayerFilters, showTornadoCta]`):

```tsx
  // Recolor every palette-driven surface when the color-vision mode changes.
  // Separate from init so toggling never rebuilds the map. Guarded on layer
  // existence so it is safe before/after style reloads.
  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;

    const eventColor = buildEventColorExpression(
      colorVisionMode,
    ) as maplibregl.ExpressionSpecification;
    for (const id of ['alert-fills-warning', 'alert-fills-watch', 'alert-fills-advisory']) {
      if (m.getLayer(id)) m.setPaintProperty(id, 'fill-color', eventColor);
    }
    for (const id of [
      'alert-outlines-warning',
      'alert-outlines-watch',
      'alert-outlines-advisory',
    ]) {
      if (m.getLayer(id)) m.setPaintProperty(id, 'line-color', eventColor);
    }

    const tornadoColorExpr = buildTornadoColorExpression(
      colorVisionMode,
    ) as maplibregl.ExpressionSpecification;
    for (const id of ['tornado-cat-outline', 'tornado-confirmed-halo', 'tornado-confirmed-pulse']) {
      if (m.getLayer(id)) m.setPaintProperty(id, 'line-color', tornadoColorExpr);
    }

    const cb = colorVisionMode === 'cbFriendly';
    for (const id of ['radar-a', 'radar-b']) {
      if (!m.getLayer(id)) continue;
      m.setPaintProperty(id, 'raster-hue-rotate', cb ? RADAR_CB_HUE_ROTATE : 0);
      m.setPaintProperty(id, 'raster-saturation', cb ? RADAR_CB_SATURATION : 0);
      m.setPaintProperty(id, 'raster-contrast', cb ? RADAR_CB_CONTRAST : 0);
    }
  }, [mapReady, colorVisionMode]);
```

- [ ] **Step 6: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: no type errors (this also resolves the `colorVisionMode is not defined` from Task 7), all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/WeatherMap.tsx
git commit -m "feat: recolor map alert layers and radar for color-vision mode"
```

---

## Task 9: Full verify + manual local check

**Files:** none (verification only)

- [ ] **Step 1: Run the full CI gate**

Run: `npm run verify`
Expected: lint → format:check → typecheck → test → build all PASS. If `format:check` fails, run `npm run format` and re-run, then amend the last commit or add a `chore: format` commit.

- [ ] **Step 2: Manual verification (the user will drive this)**

Run: `npm run dev` (serves on port 6006).

Confirm:
- Gear button visible (bottom-right); opens a panel with the "Colorblind-friendly colors" switch.
- Toggling ON recolors: alert polygon fills + outlines, the legend swatches and per-event list, the side-panel cards, the tornado status glyphs, and the radar layer (green→blue / red→magenta shift).
- Toggling OFF restores the current look exactly.
- Reload the page with the toggle ON → it stays on (localStorage persisted).
- Spot-check with a browser CVD-simulation extension that families remain distinguishable.

- [ ] **Step 3: No commit** (verification only). Implementation branch `feat/colorblind-mode` is ready for the user to verify.

---

## Self-Review

- **Spec coverage:** Preferences store (Task 1) ✓; mode-aware alert palette (Task 2) ✓; tornado ramp (Task 3) ✓; map color expressions incl. radar (Tasks 4, 8) ✓; legend (Task 5/6) ✓; side panel + popup (Task 7) ✓; settings gear/panel (Task 5) ✓; testing incl. default-look regression (Tasks 2, 3, 4, 5) ✓; verification (Task 9) ✓.
- **Default-look guarantee:** Locked by `alertPaint.test.ts` (default expression deep-equals the legacy literal) + `alerts.test.ts`/`tornado.test.ts` default-mode regression cases + radar defaults to MapLibre no-op values.
- **Type consistency:** `ColorVisionMode` defined once in `colorVisionMode.ts`; selectors `warningColorsFor`/`fallbackColorFor`/`tornadoCategoryColorsFor` and builders `buildEventColorExpression`/`buildTornadoColorExpression` are named identically everywhere they appear; store API `getPreferences`/`setColorVisionMode`/`subscribePreferences`/`useColorVisionMode`/`__resetPreferencesForTests` consistent across store + tests + components.
- **Placeholder scan:** none.
- **Known pre-existing quirk left intact (intentional, documented in Task 4):** Freeze* and Special Weather Statement render gray on the map (legend/panel still color them); not "fixed" here to honor the no-visual-change constraint.
