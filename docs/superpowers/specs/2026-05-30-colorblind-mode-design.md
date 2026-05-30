# Colorblind-Friendly Mode — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorm) — pending implementation plan
**Scope:** `seestorm-client` only. No ingest / umbrella changes.

## Problem

Users have repeatedly asked for a color-blind accessibility mode. SeeStorm's
severity signaling leans on a warm-to-cool color palette (red Tornado, orange
Severe, dark-red Floods) that collapses into a single indistinct band for
red-green color-vision deficiency (CVD) — deuteranopia and protanopia, the most
common forms (~8% of males). The radar reflectivity layer (green→yellow→red)
has the same failure mode, and it's the most safety-critical: light rain and a
dangerous heavy core read as the same brightness.

The primary user we are designing for is red-green colorblind.

## Goals

- An **opt-in** "Colorblind-friendly colors" setting that swaps in a palette
  engineered to stay distinguishable across deuteranopia, protanopia, and
  tritanopia.
- Cover every surface the client controls: alert polygons (fill + outline),
  the tornado escalation ladder, the map legend, the side panel, and the
  radar layer.
- Preserve the existing non-color cues (tier opacity, dashed/solid strokes,
  per-event icons, the confirmed-tornado pulse) — color is never the only
  signal.

## Non-Goals (v1)

- **No change to the default palette or look.** Unset users see today's app
  byte-for-byte. This is a hard constraint.
- No per-CVD-type selector (single universal CVD-safe palette only).
- No OS/browser auto-detection — there is no standard media query for color
  vision, so the mode is explicit-only.
- No basemap recoloring.

## Approach

Chosen approach (of three considered): **a parallel CVD-safe palette plus a
mode-aware selector.** Colors already centralize in `WARNING_COLORS`
(`alerts.ts`) and `TORNADO_CATEGORY_COLOR` (`tornado.ts`), read by the map,
legend, and side panel. We add parallel CB constants and route every read
through a mode-aware selector. The MapLibre `match` expressions and radar
raster paint properties are rebuilt from the active palette on toggle.

Rejected:
- **CSS-variable indirection** — MapLibre's WebGL paint expressions can't read
  CSS variables, so it would split the color system and leave the map (the
  surface that matters most) uncovered.
- **Whole-app daltonization filter** — muddies basemap, labels, radar, and
  text indiscriminately; no semantic control over urgency.

## Components

### 1. Preferences store — `src/lib/preferences.ts` (new)

Mirrors the established `userLocation.ts` + `snapshotStore.ts` patterns:
localStorage-backed, `useSyncExternalStore` for React reactivity, a custom
event for cross-tab + cross-component sync, SSR-safe (`window` guarded).

```ts
export type ColorVisionMode = 'default' | 'cbFriendly';
export interface Preferences { colorVisionMode: ColorVisionMode; }
```

- Storage key: `seestorm:preferences`.
- **Default when unset / on parse failure: `{ colorVisionMode: 'default' }`** —
  guarantees the current look for anyone who never opts in.
- Exposes `getPreferences()`, `setColorVisionMode(mode)`, a
  `subscribe(listener)`, and a `useColorVisionMode()` hook returning
  `[mode, setMode]`.
- Garbage / partial localStorage values coerce to the default.

### 2. Mode-aware palette — `src/lib/alerts.ts`, `src/lib/tornado.ts` (extend)

Add parallel constants and make the selectors take an optional mode that
defaults to `'default'`, so **every existing caller is unaffected**:

```ts
export function colorForEvent(event: string, mode: ColorVisionMode = 'default'): string
export function tornadoColor(d: TornadoDetection, mode: ColorVisionMode = 'default'): string
```

The CB alert palette is **family-based** — one Okabe–Ito (color-universal)
hue per family. Within a family, the Warning/Watch/Advisory tier stays encoded
by the fill-opacity + dashed/solid stroke the app already applies, which is a
cleaner and more accessible encoding than today's per-tier hue mix.

| Family | CB hue | Events mapped |
|---|---|---|
| Tornado | `#D55E00` | Tornado Warning, Tornado Watch |
| Severe Thunderstorm | `#E69F00` | Severe Thunderstorm Warning, Severe Thunderstorm Watch |
| Flash Flood | `#0072B2` | Flash Flood Warning, Flash Flood Watch |
| Flood | `#56B4E9` | Flood Warning, Flood Watch, Flood Advisory, Flood Statement |
| Freeze | `#CC79A7` | Freeze Warning, Freeze Watch |
| Special Weather Statement | `#009E73` | Special Weather Statement |
| Fallback | `#BBBBBB` | unmapped events |

Tornado category ladder (CB) — a single magenta-family ramp that climbs in
brightness (brighter = more severe = more visible on the dark map), stable
across CVD types and reinforced by the existing category-scaled halo width +
confirmed pulse:

| Category | CB color |
|---|---|
| RADAR_INDICATED | `#B05CA8` |
| CONFIRMED | `#D44FA0` |
| PDS | `#F06595` |
| EMERGENCY | `#FF9EC4` |

**Closest pair caveat:** Tornado (`#D55E00`) vs Severe (`#E69F00`) is the
tightest under deuteranopia — no 6-hue set fully separates a "red" from an
"orange" for red-green vision. Mitigated by bolder tornado fill opacity, the
tornado icon, and the confirmed-tornado pulse. Accepted by stakeholder.

### 3. Map wiring — `src/components/WeatherMap.tsx` (modify)

- Build the alert `eventColor` and tornado color as MapLibre `match`
  expressions keyed on **stable feature fields** (`event` string,
  `tornadoCategory`) resolved against the active palette — **not** baked hex
  in GeoJSON properties. This lets a mode flip rebuild expressions without
  re-fetching or re-deriving features.
  - If any baked `tornadoColor` property is currently read by a layer, switch
    that layer to a `match` on `tornadoCategory` so color is never stale.
- Radar recolor on the same flip, via native raster paint properties on the
  radar raster layer(s):
  - CB mode: `raster-hue-rotate ≈ 100`, small positive `raster-saturation`
    (~0.25) and `raster-contrast` (~0.1). **Starting values — tunable against
    live radar during implementation.**
  - Default mode: `raster-hue-rotate: 0`, `raster-saturation: 0`,
    `raster-contrast: 0` (no-op, preserves current radar).
- Subscribe to the preferences store (`useSyncExternalStore`) and apply
  changes via `setPaintProperty` (or rebuild affected layers) on mode change.

### 4. Legend + side panel — `src/components/MapLegend.tsx`, `AlertsPanel.tsx` (light touch)

Both already derive colors through the selectors and re-render on store change,
so swatches, cards, and `currentColor`-driven icons follow automatically once
the selectors are mode-aware and the components read the current mode. No
per-component palette tables.

### 5. Settings UI — `src/components/SettingsButton.tsx` + `SettingsPanel.tsx` (new)

- A gear-icon control placed with the map controls (top corner), respecting the
  safe-area insets already handled for MapLibre controls in `globals.css`.
- Opens a small popover/panel containing one accessible switch:
  **"Colorblind-friendly colors"** with a one-line description.
- Accessibility: real `<button>` with `role="switch"` + `aria-checked`,
  keyboard operable, visible focus ring, labeled. Closes on outside-click / Esc.
- Writes through `setColorVisionMode`. This is the seed of a future
  preferences surface, but v1 ships exactly one control.

## Data Flow

```
SettingsPanel toggle ─▶ setColorVisionMode('cbFriendly')
        │
        ▼
preferences store (localStorage + event)  ──notify──▶ useSyncExternalStore subscribers
        │                                                    │
        ▼                                                    ▼
 WeatherMap: rebuild match exprs +                 MapLegend / AlertsPanel:
 setPaintProperty (alerts, tornado, radar)         re-render swatches/cards/icons
```

## Testing (Vitest + RTL, colocated `*.test.ts(x)`, no snapshots)

- **`preferences.test.ts`** — default when unset; round-trip set/get; garbage
  and partial localStorage coerce to default; subscribe fires on change.
- **Selector tests** — `colorForEvent` / `tornadoColor` return the CB hexes for
  `'cbFriendly'`; **regression test asserting `'default'` returns the exact
  current hexes** (locks "don't change today's look").
- **Settings toggle component test** — renders, flips, persists to the store,
  and reflects a pre-existing stored value on mount; switch is keyboard
  operable and exposes `aria-checked`.
- `npm run verify` (lint → format:check → typecheck → test → build) must pass.

## Verification (local)

`npm run dev` (port 6006). Toggle the gear → "Colorblind-friendly colors";
confirm alert polygons, legend swatches, side-panel cards, tornado emphasis,
and the radar layer all recolor live, and that toggling off restores the
current look exactly. (We can also spot-check via a CVD simulator browser
extension.)

## Open Tunables (resolved during implementation, not blockers)

- Exact radar `raster-hue-rotate` angle + saturation/contrast, dialed against
  live reflectivity.
- Final gear placement / panel styling to match the existing chrome.
