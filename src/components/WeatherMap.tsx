'use client';

import { useEffect, useMemo, useRef, useState, useCallback, startTransition } from 'react';
import maplibregl from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import { radarTileUrl, hrrrTileUrl, HRRR_STEP_MINUTES, HRRR_FRAME_COUNT } from '@/lib/radar';
import { buildMotionFeatures, setMotionVisibility } from '@/lib/stormMotion';
import {
  buildAlertViews,
  deriveMultiStateDisplay,
  parseIngestSnapshot,
  WARNING_COLORS,
  colorForEvent,
  type AlertsResponse,
  type AlertTier,
  type IngestAlert,
  type WeatherAlert,
} from '@/lib/alerts';
import { buildCountyLookup, type CountyLookup } from '@/lib/countyGeometry';
import { boostBasemapContrast } from '@/lib/mapContrast';
import { alertLayerFilter } from '@/lib/alertFilter';
import { getUserLocation, USER_LOCATION_KEY } from '@/lib/userLocation';
import { applyGeoDefaultIfNeeded } from '@/lib/geoDefault';
import { STATE_VIEW_ZOOM } from '@/lib/coverage';
import { uspsToFips } from '@/lib/stateFips';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { fetchJsonWithRetry, isAbortError } from '@/lib/fetchWithRetry';
import { useClockOffset } from '@/lib/useClockOffset';
import { publishSnapshot } from '@/lib/snapshotStore';
import AlertsPanel from './AlertsPanel';
import LocationChip from './LocationChip';
import MapLegend from './MapLegend';

// Wisconsin center — kept for backward reference (single-state legacy view).
// No longer the default initial extent now that SeeStorm covers the
// multi-state Great Lakes basin.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for docs/back-compat
const WISCONSIN_CENTER: [number, number] = [-89.5, 44.5];
const DEFAULT_ZOOM = 7;

// Great Lakes default extent — covers the 9-state ingest scope
// (MN/WI/IA/IL/IN/MI/OH/PA/NY) with Lake Michigan at the visual center.
const MIDWEST_CENTER: [number, number] = [-87, 43];
const MIDWEST_ZOOM = 5;
// Zoom we hydrate to when the user has a saved ZIP — close enough to read
// county-level features without losing the surrounding storm context.
const USER_LOCATION_ZOOM = 8;

// Radar animation tuning. These values balance responsiveness (slider feels
// immediate) against smoothness (no visible popping during playback).
//
// Radar opacity ramps by zoom: intense when zoomed out (radar needs to punch
// through the basemap at the 9-state default extent), lighter when zoomed in
// (so county / city lines stay legible at the local view). The zoom-8 value
// of 0.28 preserves the previously tuned county-zoom look exactly; the
// zoom-5 bump to 0.75 and zoom-12 fade to 0.15 extend the ramp outward.
//
// Narrow cast: MapLibre's `ExpressionSpecification` is a recursive tuple union
// that TS won't unify with the inferred readonly-tuple literal here. Declaring
// a plain array and casting once via `unknown` keeps us out of `any` (which
// CLAUDE.md forbids) while letting `setPaintProperty` and the layer paint
// definition accept the expression.
const RADAR_OPACITY_EXPR: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5,
  0.75,
  8,
  0.28,
  12,
  0.15,
] as unknown as ExpressionSpecification;
const CROSSFADE_MS = 300; // A↔B layer opacity crossfade
const TILE_FADE_MS = 400; // MapLibre built-in in-tile fade

// ---------------------------------------------------------------------------
// Types matching the Worker + ingest contract
// ---------------------------------------------------------------------------

// History list from `/v1/history`.
interface HistoryEntry {
  ts: string;
  generated_at: string;
}

interface HistoryResponse {
  snapshots: HistoryEntry[];
  truncated: boolean;
  count: number;
}

// Apply the per-state county-line filter on the `admin-counties-line` layer.
// Only the selected state's counties render; if no state is selected (or the
// state isn't in the 9-state scope), the filter hides every feature so a
// zoomed-out user doesn't see a busy 9-state county mesh.
//
// Pulled out of the component so the load handler and `handleLocationChange`
// share one definition — drift between those two call sites would manifest
// as "county lines stuck on the wrong state until the next state change".
function applyCountyFilter(m: maplibregl.Map, usps: string | null): void {
  if (!m.getLayer('admin-counties-line')) return;
  const fips = uspsToFips(usps);
  // MapLibre filter typing across versions is finicky — `setFilter` accepts
  // the legacy array form unconditionally, so we cast to the runtime shape
  // rather than fighting the union.
  const filter = fips
    ? (['==', ['get', 'STATE'], fips] as maplibregl.FilterSpecification)
    : (['==', ['get', 'STATE'], '__none__'] as maplibregl.FilterSpecification);
  m.setFilter('admin-counties-line', filter);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WeatherMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Which radar layer is currently on top (fully visible). The other is the
  // staging layer — we load the next URL into it, then crossfade.
  const activeRadar = useRef<'a' | 'b'>('a');
  // URL currently displayed by the active radar layer. Tracked so the radar
  // effect can no-op when its dep array fires for unrelated reasons in
  // historical/forecast mode — those URLs encode a timestamp, so an identical
  // URL means identical tile content and re-firing `setTiles` is pure waste.
  //
  // CRITICAL: this guard MUST NOT apply in live mode. `radarTileUrl('live')`
  // returns a constant URL pointing at a Mesonet endpoint whose response
  // *content* changes every few minutes; the only way fresh live radar makes
  // it on screen is the 30s history poll re-firing this effect and calling
  // `setTiles` to invalidate the source's tile pyramid. Deduping live URLs
  // would freeze the live view at the first tick — see live-mode bypass below.
  const lastRadarUrl = useRef<string | null>(null);

  // County-name → polygon lookup, populated once the bundled counties
  // GeoJSON finishes loading. Used to hydrate zone-only alerts (Tornado
  // Watches, etc.) with synthesized geometry so they render on the map.
  // Null until load completes — callers of buildAlertViews pass it
  // through optionally, so pre-load snapshots still render polygon alerts.
  const countyLookupRef = useRef<CountyLookup | null>(null);
  // Parsed county FeatureCollection kept around for point-in-polygon
  // resolution of "which county is the user's ZIP centroid in?". Separate
  // from countyLookupRef (which is name-keyed for area_desc hydration) —
  // here we need the raw geometries for turf PiP. Populated by the same
  // counties fetch that builds the lookup.
  const countyFeaturesRef = useRef<
    GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] | null
  >(null);
  // Mirror of "refetch whichever frame the user is currently viewing".
  // Kept in a ref so async handlers outside React's dependency graph (e.g.
  // the counties-loaded callback in the map `load` handler) can hydrate the
  // current frame without hardcoding the live path — scrubbing to history
  // before counties finish loading must NOT get clobbered with live data.
  const refreshCurrentFrameRef = useRef<(() => void) | null>(null);

  // Full alert list (polygon + zone-only). Polygon features are pushed
  // directly into the MapLibre source via renderFeatures — no React state
  // needed for them. This list is what the AlertsPanel and the count
  // badge consume, so Watches and other zone-aggregate products (no polygon)
  // remain visible even though they can't be drawn on the map.
  const [allAlerts, setAllAlerts] = useState<WeatherAlert[]>([]);
  const [snapshotTime, setSnapshotTime] = useState<Date | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<WeatherAlert | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // sliderValue ranges 0..history.length.
  // history.length (rightmost) means "live" — poll the current snapshot every 30s.
  // 0..history.length-1 means "historical" — show snapshot at that index.
  const [sliderValue, setSliderValue] = useState<number>(0);
  const [mapReady, setMapReady] = useState<boolean>(false);
  // Playback state for the time-lapse loop. Pressing play from live rewinds to
  // the oldest frame; reaching the end wraps to 0 (radar-loop convention).
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playSpeed, setPlaySpeed] = useState<1 | 2 | 4>(1);
  // Per-tier map layer toggles driven by MapLegend. Hiding a tier removes
  // its polygons from the map while the side panel keeps listing them —
  // users never lose situational awareness, just visual clutter. Session-
  // only; a page reload restores all tiers.
  const [hiddenTiers, setHiddenTiers] = useState<Set<AlertTier>>(() => new Set());
  const toggleTier = useCallback((tier: AlertTier) => {
    setHiddenTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }, []);
  // Per-event visibility, independent of tier toggles. Session-only (resets
  // on reload) to keep this change small and avoid shipping a stale-cache
  // failure mode on the public safety path. Persistence (localStorage,
  // versioned key) is a planned follow-up — see the legend-persistence
  // issue linked from FUTURE.md.
  const [hiddenEvents, setHiddenEvents] = useState<Set<string>>(() => new Set());
  const toggleEvent = useCallback((event: string) => {
    setHiddenEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  }, []);
  // `now` is a ticking reference time used only for rendering "Xm ago" labels.
  // Kept in state (not read directly via Date.now() in render) so React 19's
  // purity lint stays happy and re-renders only fire at the cadence we choose.
  // Calibrated via `useClockOffset` below so users with a skewed laptop clock
  // see correct relative-time labels against `generated_at_ms` from ingest.
  const [now, setNow] = useState<number>(() => Date.now());

  // Clock-offset hook — every successful fetch below records the server's
  // `generated_at_ms` so `serverNow()` returns a calibrated "now". Consumers
  // that would otherwise call `Date.now()` for relative-time math should use
  // `serverNow()` instead (see `historicalLabel` below, and the AlertsPanel
  // `now` prop). Old payloads without `generated_at_ms` fall back to offset=0.
  const { serverNow, recordServerTime } = useClockOffset();

  // Slider range is: 0 .. history.length-1 (historical)
  //                  history.length (live)
  //                  history.length+1 .. history.length+HRRR_FRAME_COUNT (forecast)
  const sliderMax = history.length + HRRR_FRAME_COUNT;
  const isForecast = sliderValue > history.length;
  const isLive = !isForecast && (history.length === 0 || sliderValue === history.length);
  // Minutes ahead of now for the current forecast frame (0 when not forecasting).
  const forecastOffsetMin = isForecast ? (sliderValue - history.length) * HRRR_STEP_MINUTES : 0;

  // Select an alert AND pan/zoom the map to its geometry. Wired to the
  // AlertsPanel card click so the map jumps to the area the user wants to
  // see — critical for zone-aggregate Watches that cover whole counties the
  // user may not currently have in view.
  //
  // Deliberately NOT used by the map's own polygon click handler: if a user
  // clicks a polygon on the map, they're already looking at it; recentering
  // would yank the viewport they just oriented themselves in.
  //
  // Zone-only alerts without hydrated geometry (Watches that arrived before
  // the county lookup finished loading) just select — no jump — which
  // matches user expectation (nothing to fly to).
  const focusAlert = useCallback((alert: WeatherAlert) => {
    setSelectedAlert(alert);
    const m = map.current;
    if (!m || !alert.geometry) return;
    try {
      // turf.bbox returns [minX, minY, maxX, maxY] for 2D geometries — NWS
      // alert polygons are always 2D, so the 4-element form is safe.
      const [minX, minY, maxX, maxY] = turf.bbox(alert.geometry);
      // For a degenerate bbox (single-point alert) fitBounds would throw or
      // zoom to max — flyTo with a sane zoom keeps the UX predictable.
      if (minX === maxX && minY === maxY) {
        m.flyTo({
          center: [minX, minY],
          zoom: Math.max(m.getZoom(), 9),
          duration: 800,
        });
        return;
      }
      m.fitBounds(
        [
          [minX, minY],
          [maxX, maxY],
        ],
        { padding: 80, maxZoom: 10, duration: 800 },
      );
    } catch (err) {
      // Malformed geometry shouldn't break the click — just skip the pan.
      console.error('Failed to center map on alert:', err);
    }
  }, []);

  // Paint a FeatureCollection onto the map's alerts source.
  const renderFeatures = useCallback((features: AlertsResponse) => {
    if (!map.current?.getSource('alerts')) return;
    (map.current.getSource('alerts') as maplibregl.GeoJSONSource).setData(
      features as unknown as GeoJSON.FeatureCollection,
    );
  }, []);

  // Paint storm-motion features (origin / projected line / tick marks) onto
  // the separate `alert-motion` source. Kept off the main alerts source so
  // the polygon rendering path is untouched when an alert carries motion.
  const renderMotion = useCallback((ingestAlerts: IngestAlert[]) => {
    if (!map.current?.getSource('alert-motion')) return;
    const fc = buildMotionFeatures(ingestAlerts);
    (map.current.getSource('alert-motion') as maplibregl.GeoJSONSource).setData(fc);
  }, []);

  // User's saved state (if any) — drives the userState filter so the side
  // panel and map don't drown the user in alerts from the other 7 Great
  // Lakes states. Hydrated from localStorage after mount to stay SSR-safe.
  // If nothing is saved, we ask the Worker's `/v1/geo` endpoint for a
  // best-effort IP-derived default — silently no-op on any failure mode so
  // the picker stays empty (matches the post-county-fix baseline).
  const [userState, setUserStateLocal] = useState<string | null>(null);
  // `pendingGeoDefault` holds the location resolved from the IP fetch on
  // first visit so the post-mapReady effect below can fly the map and apply
  // the county filter — both of which depend on the MapLibre instance being
  // initialized, which doesn't happen until the load handler fires.
  const pendingGeoDefaultRef = useRef<{ state: string; lat: number; lon: number } | null>(null);
  useEffect(() => {
    const loc = getUserLocation();
    if (loc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration from localStorage
      setUserStateLocal(loc.state);
      return;
    }
    // No saved location — try the IP-based default. Cancellation guard
    // prevents a late-arriving fetch from clobbering a manual pick the user
    // made in the meantime (e.g. they opened the chip and picked a state
    // before /v1/geo returned).
    let cancelled = false;
    void applyGeoDefaultIfNeeded().then((outcome) => {
      if (cancelled) return;
      if (outcome.kind !== 'applied') return;
      // Race guard: if a manual pick landed during the fetch, defer to it.
      const current = getUserLocation();
      if (current && current.source !== 'ip') return;
      pendingGeoDefaultRef.current = {
        state: outcome.location.state,
        lat: outcome.location.lat,
        lon: outcome.location.lon,
      };
      setUserStateLocal(outcome.location.state);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Once both the map is ready AND we have a pending IP-derived default,
  // fly to the inferred state and apply the county filter. Kept separate
  // from the localStorage hydration effect because either input can resolve
  // first — we wait for both before touching MapLibre.
  useEffect(() => {
    if (!mapReady) return;
    const pending = pendingGeoDefaultRef.current;
    if (!pending) return;
    const m = map.current;
    if (!m) return;
    pendingGeoDefaultRef.current = null;
    applyCountyFilter(m, pending.state);
    m.flyTo({
      center: [pending.lon, pending.lat],
      zoom: STATE_VIEW_ZOOM,
      duration: 800,
    });
  }, [mapReady, userState]);
  // Keep the latest filter state in a ref so async fetch callbacks read the
  // current value without re-creating themselves on every change (which would
  // tear down the polling interval).
  const userStateRef = useRef<string | null>(null);
  useEffect(() => {
    userStateRef.current = userState;
  }, [userState]);

  // ZIP-precise point filter — populated when the saved location carries a
  // `zip` field (signals "ZIP entry mode" vs "state picker mode"). When set,
  // takes precedence over `userState` in buildAlertViews and gives pixel-
  // precise filtering for polygon-bearing alerts (Warnings) while still
  // surfacing zone-only alerts (Watches) at the user's state.
  //
  // Hydrated from localStorage in the same effect that hydrates `userState`
  // (see below) so the two stay in lockstep — we never want a userPoint
  // without a corresponding userState fallback.
  const userPointRef = useRef<{ lat: number; lon: number; state: string } | null>(null);

  // applyUserCountyHighlight: PiP-resolves the county containing the user's
  // saved ZIP and updates the `admin-counties-user-highlight` layer's filter
  // to match (or hides the layer when no ZIP is set / counties haven't
  // loaded yet / no county contains the point — which can happen for ZIPs
  // outside our 9-state coverage).
  //
  // Held in a ref so the counties-loaded async callback in the map `load`
  // handler can re-resolve when its data arrives — without taking a
  // dependency on the function identity (which would re-run the load
  // handler every render).
  const applyUserCountyHighlightRef = useRef<(() => void) | null>(null);

  // Sync BOTH userState (chip + map fly) AND userPointRef (precise filter)
  // from any userLocation change. Listens to:
  //   1. The custom `seestorm:user-location-changed` event — fires on
  //      same-tab writes (LocationChip pick / clear / ZIP submit, geo
  //      default fetch).
  //   2. The browser-native `storage` event — fires only in OTHER tabs
  //      when localStorage is mutated, scoped to USER_LOCATION_KEY.
  //
  // Updating both together keeps the map's filters in lockstep with the
  // chip's display: a cross-tab change to ZIP-A while this tab was on
  // ZIP-B used to leave the map filtering against ZIP-B (split-brain).
  // Now both flip together — chip text, userState fallback, userPoint
  // precise filter — matching what the user sees in the chip elsewhere.
  useEffect(() => {
    function syncFromStorage() {
      const loc = getUserLocation();
      // userState drives the coarse filter + chip display + downstream
      // effects (map fly, county filter). null when no saved location.
      setUserStateLocal(loc?.state ?? null);
      // userPointRef drives the precise filter — only when the saved
      // location carries a `zip` field (signals ZIP-entry mode vs
      // state-picker mode).
      if (loc && typeof loc.zip === 'string' && loc.zip.length > 0) {
        userPointRef.current = { lat: loc.lat, lon: loc.lon, state: loc.state };
      } else {
        userPointRef.current = null;
      }
      // Re-resolve which county to highlight whenever the saved location
      // changes. Cheap (one PiP per county feature in a ~650-feature set)
      // and only runs when the user actually changes locations.
      applyUserCountyHighlightRef.current?.();
    }
    // Initial sync — pick up any previously-saved location on first
    // render so the user-county highlight resolves on the first poll
    // cycle rather than waiting for the next location change.
    syncFromStorage();
    // Same-tab event from LocationChip / geoDefault / clear.
    window.addEventListener('seestorm:user-location-changed', syncFromStorage);
    // Cross-tab event — browser fires `storage` only on OTHER tabs when
    // localStorage changes. Filter to the user-location key so we don't
    // re-sync on unrelated keys.
    const onStorage = (e: StorageEvent) => {
      if (e.key === USER_LOCATION_KEY) syncFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('seestorm:user-location-changed', syncFromStorage);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // User-county highlight resolver: PiP-finds the county containing the
  // user's saved ZIP and updates the highlight layer's filter to match.
  // Defined as a useEffect (not just a plain function) so it can re-run
  // when mapReady flips and so the cleanup nulls the ref — preventing the
  // counties-loaded callback from calling into a stale closure after
  // unmount.
  //
  // Hides the layer (filter to '__none__') when:
  //   - no userPoint set (user picked a state chip, not a ZIP)
  //   - county data hasn't loaded yet
  //   - userPoint is outside any covered county (out-of-coverage ZIP)
  useEffect(() => {
    if (!mapReady) return;
    const m = map.current;
    if (!m) return;

    function applyHighlight() {
      // Re-bind from the ref each call — the outer `m` narrowing doesn't
      // carry into a closure that may be invoked from event handlers later.
      const mapInstance = map.current;
      if (!mapInstance) return;
      const layerId = 'admin-counties-user-highlight';
      if (!mapInstance.getLayer(layerId)) return;
      const userPt = userPointRef.current;
      const features = countyFeaturesRef.current;
      if (!userPt || !features) {
        mapInstance.setFilter(layerId, ['==', ['get', 'STATE'], '__none__']);
        return;
      }
      // Iterate counties and PiP-test against the user's coordinates.
      // 650 features × O(polygon edges) — single-digit ms in practice.
      // Wrapped in try so a malformed feature can't blank the layer.
      for (const f of features) {
        try {
          if (turf.booleanPointInPolygon(turf.point([userPt.lon, userPt.lat]), f)) {
            const props = f.properties as { STATE?: string; COUNTY?: string } | null;
            if (props?.STATE && props.COUNTY) {
              mapInstance.setFilter(layerId, [
                'all',
                ['==', ['get', 'STATE'], props.STATE],
                ['==', ['get', 'COUNTY'], props.COUNTY],
              ]);
              return;
            }
          }
        } catch {
          // Bad feature — skip rather than abort. The match (if any)
          // continues; if nothing matches, we hide the layer below.
        }
      }
      // No matching county (out-of-coverage ZIP, or features list is
      // smaller than the coverage area for some reason). Hide cleanly.
      mapInstance.setFilter(layerId, ['==', ['get', 'STATE'], '__none__']);
    }

    applyUserCountyHighlightRef.current = applyHighlight;
    // Run once on wire-up so a hydrated location resolves immediately
    // (the syncFromStorage path also calls this, but that may have run
    // before the map was ready).
    applyHighlight();

    return () => {
      applyUserCountyHighlightRef.current = null;
    };
  }, [mapReady]);

  // Fetch the live snapshot (/v1/active-events.json) — used when sliderValue
  // is live. Wrapped in an AbortController so the caller (effect cleanup,
  // unmount, live→historical state transition) can cancel an in-flight
  // fetch; retried with exponential backoff on transient failure per
  // FETCH_RETRY_DELAYS_MS. See swarm audit 2026-04-18, Tier 1 #2c.
  const fetchLive = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const raw = await fetchJsonWithRetry('/v1/active-events.json', { signal });
        const snapshot = parseIngestSnapshot(raw);
        // Calibrate clock offset against the server's generation timestamp,
        // and publish into the global store so the root-layout StalenessBanner
        // can render without threading props through the dynamic map import.
        recordServerTime(snapshot.generated_at_ms);
        publishSnapshot(snapshot.generated_at_ms ?? null, { isLive: true });
        const { mapFeatures, listAlerts, motionAlerts } = buildAlertViews(snapshot, {
          countyLookup: countyLookupRef.current ?? undefined,
          userState: userStateRef.current ?? undefined,
          userPoint: userPointRef.current ?? undefined,
        });
        // Defer the heavy state apply off the click thread. `source.setData()`
        // with the full GeoJSON blob is what pinned production INP at 2,104 ms
        // on the LIVE pill (swarm audit 2026-04-18, Tier 1 #1). React 19's
        // startTransition lets the click handler return immediately and lets
        // MapLibre parse/diff polygons on a lower-priority render pass.
        startTransition(() => {
          setAllAlerts(listAlerts);
          setSnapshotTime(new Date(snapshot.generated_at));
          renderFeatures(mapFeatures);
          // Use the filtered set so storm-motion arrows respect the same
          // userState scoping as the polygons/list. Otherwise users with a saved
          // ZIP see arrows from the other 7 states leaking through.
          renderMotion(motionAlerts);
        });
      } catch (err) {
        // Aborts are intentional (unmount / state transition). Swallow them
        // silently — surfacing "live fetch failed" after the user navigated
        // away would be misleading. Real failures (retry exhausted) still log.
        if (isAbortError(err)) return;
        console.error('Failed to fetch live snapshot:', err);
      }
    },
    [renderFeatures, renderMotion, recordServerTime],
  );

  // Fetch one historical snapshot by timestamp key. Same abort/retry discipline
  // as `fetchLive` — scrubbing the slider rapidly must cancel the previous
  // fetch so we don't race payloads into render out-of-order.
  const fetchHistorical = useCallback(
    async (ts: string, signal?: AbortSignal) => {
      try {
        const raw = await fetchJsonWithRetry(`/v1/history/${ts}`, { signal });
        const snapshot = parseIngestSnapshot(raw);
        // Historical snapshots carry intentionally old `generated_at_ms`
        // values. Feeding them into the clock-offset calibration poisons
        // `serverNow()` (Codex review, Tier 1 remediation — Fix 2) and
        // publishing them into the staleness store would trip the banner.
        // The banner + offset are LIVE-data honesty signals only, so we
        // deliberately skip `recordServerTime` here and pass `isLive:false`
        // to `publishSnapshot` so the store no-ops.
        publishSnapshot(snapshot.generated_at_ms ?? null, { isLive: false });
        const { mapFeatures, listAlerts, motionAlerts } = buildAlertViews(snapshot, {
          countyLookup: countyLookupRef.current ?? undefined,
          userState: userStateRef.current ?? undefined,
          userPoint: userPointRef.current ?? undefined,
        });
        // Same rationale as fetchLive — defer the heavy state apply so the
        // playback-bar click handler returns fast. See Tier 1 #1 in the swarm
        // audit (2026-04-18).
        startTransition(() => {
          setAllAlerts(listAlerts);
          setSnapshotTime(new Date(snapshot.generated_at));
          renderFeatures(mapFeatures);
          renderMotion(motionAlerts);
        });
      } catch (err) {
        if (isAbortError(err)) return;
        console.error('Failed to fetch historical snapshot:', err);
      }
    },
    [renderFeatures, renderMotion],
  );

  // Keep `refreshCurrentFrameRef` pointed at a closure that re-fetches the
  // frame the user is *currently* looking at — live snapshot when on live,
  // the active historical snapshot otherwise. The counties-loaded callback
  // calls through this so hydrating late-arriving county polygons never
  // replaces a user-selected historical frame with live data.
  useEffect(() => {
    refreshCurrentFrameRef.current = () => {
      if (isLive) {
        void fetchLive();
        return;
      }
      const entry = history[sliderValue];
      if (entry) void fetchHistorical(entry.ts);
    };
  }, [isLive, sliderValue, history, fetchLive, fetchHistorical]);

  // Fetch the history index from the Worker.
  const fetchHistory = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const raw = await fetchJsonWithRetry('/v1/history?limit=60', { signal });
        const data = raw as HistoryResponse;
        // API returns newest-first; reverse so index 0 is oldest, len-1 is newest.
        const ordered = data.snapshots.slice().reverse();
        setHistory((prev) => {
          // If the slider was on "live" (== prev.length), keep it on "live" after the list grows.
          if (sliderValue === prev.length) {
            setSliderValue(ordered.length);
          }
          return ordered;
        });
      } catch (err) {
        if (isAbortError(err)) return;
        console.error('Failed to fetch history index:', err);
      }
    },
    [sliderValue],
  );

  // When in live mode, poll live + refresh history list every POLL_INTERVAL_MS.
  // All in-flight fetches are owned by a single AbortController per effect run
  // so the cleanup aborts them on unmount AND on the live→historical state
  // transition (swarm audit 2026-04-18, Tier 1 #2c). A visibilitychange and a
  // focus listener both fire an immediate refetch — background-tab throttling
  // would otherwise let the 30s setInterval drift well past the 90s staleness
  // threshold while the user's tab is hidden.
  //
  // fetchLive/fetchHistory are async — setState happens after `await`, not
  // synchronously in this effect body — so react-hooks/set-state-in-effect
  // is a false positive here.
  useEffect(() => {
    if (!mapReady || !isLive) return;
    const controller = new AbortController();
    const { signal } = controller;

    void fetchLive(signal);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setState post-await
    void fetchHistory(signal);

    const interval = setInterval(() => {
      void fetchLive(signal);
      void fetchHistory(signal);
    }, POLL_INTERVAL_MS);

    // Browsers throttle setInterval in hidden tabs — without these listeners
    // a user returning to SeeStorm after a coffee would see a minutes-old
    // snapshot until the next tick. Refetch immediately when either signal
    // fires; dedupe is unnecessary because AbortController cancels the stale
    // in-flight request on the next state change.
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void fetchLive(signal);
        void fetchHistory(signal);
      }
    };
    const onFocus = (): void => {
      void fetchLive(signal);
      void fetchHistory(signal);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      controller.abort();
    };
  }, [mapReady, isLive, fetchLive, fetchHistory]);

  // When scrubbed to historical, fetch that snapshot. Same async-setState
  // pattern. AbortController cleanup cancels the previous historical fetch
  // when the user drags the slider rapidly.
  useEffect(() => {
    if (!mapReady || isLive) return;
    const entry = history[sliderValue];
    if (!entry) return;
    const controller = new AbortController();
    void fetchHistorical(entry.ts, controller.signal);
    return () => controller.abort();
  }, [mapReady, isLive, sliderValue, history, fetchHistorical]);

  // Auto-advance the slider when playing. 500ms per frame at 1x — fast enough
  // that motion is obvious, slow enough that each 5-min tile has time to load.
  useEffect(() => {
    if (!isPlaying || history.length === 0) return;
    const frameMs = 500 / playSpeed;
    const id = setInterval(() => {
      setSliderValue((v) => {
        // Full loop: historical → live → forecast → wrap to oldest historical.
        // This gives a continuous "past into future" animation the user can
        // watch without touching anything.
        if (v >= history.length + HRRR_FRAME_COUNT) return 0;
        return v + 1;
      });
    }, frameMs);
    return () => clearInterval(id);
  }, [isPlaying, playSpeed, history.length]);

  const togglePlay = useCallback(() => {
    setIsPlaying((p) => {
      // Starting playback from live → rewind to the oldest frame so there's
      // something visible to play. Otherwise toggle in place.
      if (!p && isLive && history.length > 0) setSliderValue(0);
      return !p;
    });
  }, [isLive, history.length]);

  const stepBack = useCallback(() => {
    setIsPlaying(false);
    setSliderValue((v) => Math.max(0, v - 1));
  }, []);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    setSliderValue((v) => Math.min(history.length + HRRR_FRAME_COUNT, v + 1));
  }, [history.length]);

  // Crossfade the radar between frames.
  //
  // Push the next URL into the *inactive* raster source (so tiles start
  // streaming in behind the current frame), then flip opacity on both
  // layers. The currently-visible frame stays lit while the new one loads,
  // so the user never sees a blank flash — the whole thing reads as smooth
  // storm motion instead of a strobe.
  //
  // MapLibre's `RasterTileSource.setTiles()` triggers a tile reload without
  // tearing down the source, which preserves the in-progress tile cache for
  // zoom/pan interactions during scrubbing.
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const m = map.current;

    let url: string;
    if (isForecast) {
      url = hrrrTileUrl(forecastOffsetMin);
    } else if (isLive) {
      url = radarTileUrl('live');
    } else {
      const entry = history[sliderValue];
      if (!entry) return;
      url = radarTileUrl(new Date(entry.generated_at));
    }

    // Skip the crossfade entirely when the URL hasn't changed AND we're not in
    // live mode. Historical / forecast URLs encode a timestamp — an identical
    // URL really does mean identical tile content, so the previous behavior of
    // re-firing `setTiles` whenever an unrelated dep flipped (e.g. the 30s
    // history poll producing a fresh `history` array reference) was wasted
    // work that invalidated the inactive radar source's tile pyramid for no
    // visual change.
    //
    // Live mode is deliberately exempt: `radarTileUrl('live')` is a constant
    // URL pointing at a continuously-refreshing Mesonet endpoint, so the 30s
    // poll's setTiles invalidation IS the mechanism that pulls in fresh live
    // radar. Deduping it would freeze the live view at whatever tile content
    // landed on the first paint.
    if (!isLive && url === lastRadarUrl.current) return;
    lastRadarUrl.current = url;

    const current = activeRadar.current;
    const incoming = current === 'a' ? 'b' : 'a';
    const currentLayerId = `radar-${current}`;
    const incomingLayerId = `radar-${incoming}`;

    const incomingSource = m.getSource(incomingLayerId) as maplibregl.RasterTileSource | undefined;
    if (!incomingSource) return;

    // Start loading the next frame's tiles into the inactive (invisible) layer.
    incomingSource.setTiles([url]);

    // Crossfade — MapLibre animates these paint properties over CROSSFADE_MS
    // thanks to the `raster-opacity-transition` we set at layer creation.
    //
    // Critical: the "restore" side sets the full zoom-interpolation expression,
    // NOT a scalar. Passing a scalar here would clobber the zoom ramp the first
    // time the user steps the slider, leaving the radar stuck at whatever
    // opacity we happened to pick. The "inactive" side still goes to scalar 0 —
    // fully transparent is opacity-value-independent of zoom.
    m.setPaintProperty(incomingLayerId, 'raster-opacity', RADAR_OPACITY_EXPR);
    m.setPaintProperty(currentLayerId, 'raster-opacity', 0);

    activeRadar.current = incoming;
  }, [mapReady, isLive, isForecast, forecastOffsetMin, sliderValue, history]);

  // Observation-layer visibility (alert polygons + storm-motion vectors).
  // Kept separate from the radar-frame effect so a legend tier toggle
  // never incidentally triggers a radar crossfade or tile reload.
  //
  // Two gates stack:
  //   1. Forecast mode hides EVERY tier plus motion — alerts and motion are
  //      observations of what IS happening and have no meaning in a model
  //      projection frame.
  //   2. User tier toggles (from MapLegend) hide individual alert tiers so
  //      stacked watches/advisories don't muddy the map.
  // Layers stay mounted in both cases so we can flip visibility back on
  // without rebuilding the source or re-running paint expressions.
  // Alert layer filter expressions — memoized on `hiddenEvents` so the
  // MapLibre expression trees are only rebuilt when the set actually changes.
  // Without this, the arrays rebuild on every render (new reference each
  // time) and `m.setFilter` below walks MapLibre's filter-change path at
  // every 30s poll even when nothing relevant to the map has changed. On a
  // warned-heavy cell that's ~15% of main-thread time per poll.
  //
  // Deps are narrow on purpose: `alertLayerFilter` reads only `tier` (a
  // constant per entry) and `hiddenEvents`. `hiddenTiers` and `isForecast`
  // govern `visibility`, not the filter expression itself, so including
  // them here would spuriously invalidate the memo.
  const alertLayerFilters = useMemo(
    () => ({
      Warning: alertLayerFilter('Warning', hiddenEvents),
      Watch: alertLayerFilter('Watch', hiddenEvents),
      Advisory: alertLayerFilter('Advisory', hiddenEvents),
    }),
    [hiddenEvents],
  );

  useEffect(() => {
    if (!mapReady) return;
    const m = map.current;
    if (!m) return;

    const tierLayers: ReadonlyArray<{ tier: AlertTier; ids: readonly string[] }> = [
      { tier: 'Warning', ids: ['alert-fills-warning', 'alert-outlines-warning'] },
      { tier: 'Watch', ids: ['alert-fills-watch', 'alert-outlines-watch'] },
      { tier: 'Advisory', ids: ['alert-fills-advisory', 'alert-outlines-advisory'] },
    ];
    for (const { tier, ids } of tierLayers) {
      const visibility = isForecast || hiddenTiers.has(tier) ? 'none' : 'visible';
      // Layer `visibility` stays as the coarse tier/forecast gate; `filter`
      // handles finer per-event exclusions. Keeping them on separate
      // MapLibre mechanics means a single legend click only touches the
      // dimension that actually changed. Filter object is the memoized
      // reference from `alertLayerFilters` above.
      const filter = alertLayerFilters[tier];
      for (const id of ids) {
        if (!m.getLayer(id)) continue;
        m.setLayoutProperty(id, 'visibility', visibility);
        m.setFilter(id, filter);
      }
    }
    // Confirmed-tornado emphasis tracks the Warning tier gate (a Tornado
    // Warning is a Warning): it must vanish in forecast mode and when the
    // user hides Warnings, so a pulsing "TAKE COVER" ring is never
    // stranded over a model frame or a hidden tier. Filter = confirmed
    // AND the Warning event filter, so a per-event hide of "Tornado
    // Warning" (via hiddenEvents) drops the pulse too. alertLayerFilter
    // returns a modern expression tree, so nesting it under `all` is safe.
    const tornadoVisibility = isForecast || hiddenTiers.has('Warning') ? 'none' : 'visible';
    const tornadoConfirmedFilter = [
      'all',
      ['==', ['get', 'tornadoConfirmed'], true],
      alertLayerFilters.Warning,
    ] as unknown as maplibregl.FilterSpecification;
    // Category outline covers ALL tornado polygons (incl. radar-indicated),
    // still AND-gated to the Warning event filter so a per-event hide drops
    // it too.
    const tornadoPresentVisFilter = [
      'all',
      ['has', 'tornadoColor'],
      alertLayerFilters.Warning,
    ] as unknown as maplibregl.FilterSpecification;
    if (m.getLayer('tornado-cat-outline')) {
      m.setLayoutProperty('tornado-cat-outline', 'visibility', tornadoVisibility);
      m.setFilter('tornado-cat-outline', tornadoPresentVisFilter);
    }
    for (const id of ['tornado-confirmed-pulse', 'tornado-confirmed-label']) {
      if (!m.getLayer(id)) continue;
      m.setLayoutProperty(id, 'visibility', tornadoVisibility);
      m.setFilter(id, tornadoConfirmedFilter);
    }

    setMotionVisibility(m, !isForecast);
  }, [mapReady, isForecast, hiddenTiers, alertLayerFilters]);

  // Map init.
  useEffect(() => {
    if (!mapContainer.current) return;

    // Basemap style: defaults to CartoDB Dark Matter (free, no-key, works from any
    // origin, and matches the dark SeeStorm theme). Override via NEXT_PUBLIC_MAP_STYLE_URL
    // when self-hosting Protomaps on R2 or using another MapLibre-compatible style.
    const mapStyle =
      process.env.NEXT_PUBLIC_MAP_STYLE_URL ||
      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

    // Initial extent: Great Lakes basin by default. If the user has a saved
    // location (from the ZIP banner), hydrate to their coordinates at a
    // closer zoom so the first paint is immediately personal.
    //
    // SSR-safe: getUserLocation returns null on the server (no localStorage),
    // so the server-rendered shell uses MIDWEST_* and the client may then
    // re-center after hydration. Keeping this in the map init effect (which
    // is client-only) avoids a visible re-centering jump.
    const saved = getUserLocation();
    const initialCenter: [number, number] = saved ? [saved.lon, saved.lat] : MIDWEST_CENTER;
    const initialZoom = saved ? USER_LOCATION_ZOOM : MIDWEST_ZOOM;
    void DEFAULT_ZOOM; // referenced to keep export but not used as default

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: mapStyle,
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: {},
      // Bound GPU memory pressure. Default cache size is derived from viewport
      // and on a full-screen map can grow unbounded across pan/zoom — combined
      // with the dual radar raster sources + the bundled 9-state county vector
      // source, that's enough to provoke Chromium's "context loss and was
      // blocked" guard on integrated/mobile GPUs after a long session. 32
      // tiles per source is plenty for the SeeStorm viewport range (zoom 5-12)
      // while keeping the working set well under the GPU budget.
      maxTileCacheSize: 32,
    });

    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    m.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      'top-right',
    );

    m.on('load', () => {
      // Lift roads and place labels out from under the radar + alert overlays.
      // Runs once, before any of our own layers are added, so we only walk the
      // basemap's own layers and don't compound-boost on re-render.
      boostBasemapContrast(m);

      // Two alternating radar sources so we can crossfade between frames.
      // Without this, each new tile URL produces a visible blank flash while
      // MapLibre loads the new tiles. With two layers, the previous frame
      // stays visible and fades out while the new one fades in on top —
      // standard radar-loop animation technique.
      const radarSourceOptions = {
        type: 'raster' as const,
        tiles: [radarTileUrl('live')],
        tileSize: 256,
        attribution: 'NEXRAD / HRRR via Iowa Environmental Mesonet',
      };
      m.addSource('radar-a', radarSourceOptions);
      m.addSource('radar-b', radarSourceOptions);

      m.addLayer({
        id: 'radar-a',
        type: 'raster',
        source: 'radar-a',
        paint: {
          'raster-opacity': RADAR_OPACITY_EXPR,
          // 300ms crossfade between layer A and B on slider change
          'raster-opacity-transition': { duration: CROSSFADE_MS },
          // Built-in MapLibre tile fade-in — softens intra-source pop when
          // tiles arrive at different times during network load.
          'raster-fade-duration': TILE_FADE_MS,
        },
      });
      m.addLayer({
        id: 'radar-b',
        type: 'raster',
        source: 'radar-b',
        paint: {
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: CROSSFADE_MS },
          'raster-fade-duration': TILE_FADE_MS,
        },
      });

      // Administrative boundaries — state + county lines.
      //
      // Rendered from bundled GeoJSON in /public/geo/ rather than inherited
      // from the basemap style. This decouples boundary rendering from the
      // basemap provider: CartoDB Dark Matter (current), Protomaps (future),
      // or anything else we swap in will all still show boundaries.
      //
      // Sources start empty and are populated after fetch() below so the map
      // doesn't block on init if the asset is slow.
      m.addSource('admin-states', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      m.addSource('admin-counties', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Populate boundary sources asynchronously. Failures here are
      // non-critical — the map still works without boundary lines.
      void (async () => {
        try {
          const [statesRes, countiesRes] = await Promise.all([
            fetch('/geo/us-states.geojson'),
            fetch('/geo/greatlakes-counties.geojson'),
          ]);
          if (statesRes.ok) {
            const states = (await statesRes.json()) as GeoJSON.FeatureCollection;
            (m.getSource('admin-states') as maplibregl.GeoJSONSource | undefined)?.setData(states);
          }
          if (countiesRes.ok) {
            const counties = (await countiesRes.json()) as GeoJSON.FeatureCollection;
            (m.getSource('admin-counties') as maplibregl.GeoJSONSource | undefined)?.setData(
              counties,
            );
            // Stash the raw features for the user-county PiP resolver. Cast
            // is safe — Census county GeoJSON is exclusively Polygon /
            // MultiPolygon. The user-county-highlight effect runs PiP
            // against this list when a ZIP-precise location is set.
            countyFeaturesRef.current = counties.features as GeoJSON.Feature<
              GeoJSON.Polygon | GeoJSON.MultiPolygon
            >[];
            // Re-resolve the user's county now that the data is available
            // (the user may have hydrated from localStorage with a ZIP
            // before counties finished loading).
            applyUserCountyHighlightRef.current?.();
            // Build the county-name lookup once so zone-only alerts
            // (Tornado Watches) can be hydrated into MapLibre-drawable
            // polygons. Lookup is keyed by (state, name) across all 9
            // covered states so same-named counties (Washington, Monroe,
            // Lee, …) resolve to the correct state's polygon. Alert
            // `area_desc` carries state suffixes that countyGeometry
            // parses and filters on.
            // Dispatch through `refreshCurrentFrameRef` rather than
            // hardcoding fetchLive — the user may have scrubbed to history
            // while counties were loading, and we must not overwrite their
            // selected frame with live data.
            countyLookupRef.current = buildCountyLookup(counties);
            // Apply the per-state county filter now that the source is
            // populated. The user may have hydrated with a saved state
            // before this fetch completed, in which case userStateRef is
            // already set; otherwise the filter hides every feature
            // (single-state focus is the agreed UX — multi-state county
            // overlay at zoom 5 would be visually overwhelming).
            applyCountyFilter(m, userStateRef.current);
            refreshCurrentFrameRef.current?.();
          }
        } catch (err) {
          console.error('Failed to load admin boundaries:', err);
        }
      })();

      m.addSource('alerts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Per-event color expression — reused across all six tier layers below.
      // Unknown event strings fall back to gray, matching the Advisory tone.
      const eventColor: maplibregl.ExpressionSpecification = [
        'match',
        ['get', 'event'],
        'Tornado Warning',
        WARNING_COLORS['Tornado Warning'],
        'Tornado Watch',
        WARNING_COLORS['Tornado Watch'],
        'Severe Thunderstorm Warning',
        WARNING_COLORS['Severe Thunderstorm Warning'],
        'Severe Thunderstorm Watch',
        WARNING_COLORS['Severe Thunderstorm Watch'],
        'Flash Flood Warning',
        WARNING_COLORS['Flash Flood Warning'],
        'Flash Flood Watch',
        WARNING_COLORS['Flash Flood Watch'],
        // Plain hydrologic Flood products. Distinct from Flash Flood — these
        // are the slower-onset river / areal Warnings the NWS issues as
        // "FLW" / "FLS". Without these cases the polygon fell back to the
        // gray default and visually read as low-urgency despite being a
        // life-safety Warning.
        'Flood Warning',
        WARNING_COLORS['Flood Warning'],
        'Flood Watch',
        WARNING_COLORS['Flood Watch'],
        'Flood Advisory',
        WARNING_COLORS['Flood Advisory'],
        'Flood Statement',
        WARNING_COLORS['Flood Statement'],
        '#888888',
      ];

      // Tier classification happens entirely inside MapLibre filters —
      // suffix-match the `event` string so new NWS event types are placed
      // into the correct tier without any JS preprocessing. Filter math
      // lives in `lib/alertFilter.ts` so it's unit-testable without a map.
      //   Warning  → ends with " Warning"  → bold, saturated fill (take shelter)
      //   Watch    → ends with " Watch"    → dashed outline, faint fill (be aware)
      //   Advisory → everything else       → thin outline, near-transparent fill (monitor)
      // The empty-set hiddenEvents here is intentional: on load nothing is
      // hidden yet. The visibility useEffect re-applies the real filter
      // once `hiddenEvents` changes.
      const warningFilter = alertLayerFilter('Warning', new Set());
      const watchFilter = alertLayerFilter('Watch', new Set());
      const advisoryFilter = alertLayerFilter('Advisory', new Set());

      // Fills — opacity is the primary signal of urgency.
      m.addLayer({
        id: 'alert-fills-warning',
        type: 'fill',
        source: 'alerts',
        filter: warningFilter,
        paint: { 'fill-color': eventColor, 'fill-opacity': 0.15 },
      });
      m.addLayer({
        id: 'alert-fills-watch',
        type: 'fill',
        source: 'alerts',
        filter: watchFilter,
        paint: { 'fill-color': eventColor, 'fill-opacity': 0.09 },
      });
      m.addLayer({
        id: 'alert-fills-advisory',
        type: 'fill',
        source: 'alerts',
        filter: advisoryFilter,
        paint: { 'fill-color': eventColor, 'fill-opacity': 0.04 },
      });

      // County lines — drawn first (below state lines) so state borders win
      // visually when they coincide with a county edge at a state boundary.
      m.addLayer({
        id: 'admin-counties-line',
        type: 'line',
        source: 'admin-counties',
        paint: {
          // Lightened from #9ca3af / 1 / 0.6 — still distinguishable from the
          // brighter state lines above, but punches through radar + fills.
          'line-color': '#d1d5db',
          'line-width': 1.4,
          // Fade county lines at regional zoom so the radar can dominate the
          // wide view and the 9-state mesh doesn't feel cluttered. Restored
          // to the previous 0.85 by zoom 8 — the county-zoom look is preserved.
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0.3,
            8,
            0.85,
            12,
            0.85,
          ] as unknown as ExpressionSpecification,
        },
      });
      // User-county highlight — subtle but distinctly different border on
      // the single county containing the user's saved ZIP. Filter is set
      // by `applyUserCountyHighlight` to '__none__' (hide all) until a ZIP
      // is set AND its containing county is resolved. Cyan picks up nicely
      // against the dark basemap and the warning-color palette without
      // colliding with any alert-tier hue (red / orange / yellow / pink /
      // green are all tier-meaningful; cyan stays personal-context).
      m.addLayer({
        id: 'admin-counties-user-highlight',
        type: 'line',
        source: 'admin-counties',
        filter: ['==', ['get', 'STATE'], '__none__'],
        paint: {
          'line-color': '#22d3ee',
          'line-width': 2.5,
          'line-opacity': 0.9,
        },
      });
      m.addLayer({
        id: 'admin-states-line',
        type: 'line',
        source: 'admin-states',
        paint: {
          // Bumped from #9ca3af / 1.2 / 0.55. State borders are the highest-
          // value geographic reference when a storm crosses WI/MN/IL lines,
          // so we want them unambiguously readable through the overlays.
          'line-color': '#e5e7eb',
          // Fade at regional zoom so the overall storm systems read cleanly
          // when the map is pulled out — state borders are still present as
          // reference, just not dominating the view. Restored to full weight
          // by zoom 8 where county-level detail matters.
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0.9,
            8,
            1.8,
            12,
            1.8,
          ] as unknown as ExpressionSpecification,
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0.35,
            8,
            0.8,
            12,
            0.8,
          ] as unknown as ExpressionSpecification,
        },
      });

      // Outlines — line weight + dash pattern reinforce the tier. Opacity +
      // width are zoom-interpolated so flood-warning zones and other alert
      // boundaries don't stencil-dominate the overall storm-system view at
      // regional zoom (5–7). By zoom 8 (county-level) the full-weight look
      // is restored. The fill still carries the urgency signal — this only
      // softens the outline contribution when pulled out.
      const alertWarningWidth: ExpressionSpecification = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        1.2,
        8,
        3,
        12,
        3,
      ] as unknown as ExpressionSpecification;
      const alertWarningOpacity: ExpressionSpecification = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        0.45,
        8,
        0.9,
        12,
        0.9,
      ] as unknown as ExpressionSpecification;
      const alertWatchWidth: ExpressionSpecification = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        0.9,
        8,
        2,
        12,
        2,
      ] as unknown as ExpressionSpecification;
      const alertWatchOpacity: ExpressionSpecification = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        0.35,
        8,
        0.75,
        12,
        0.75,
      ] as unknown as ExpressionSpecification;
      const alertAdvisoryWidth: ExpressionSpecification = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        0.75,
        8,
        1.5,
        12,
        1.5,
      ] as unknown as ExpressionSpecification;
      const alertAdvisoryOpacity: ExpressionSpecification = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        0.28,
        8,
        0.6,
        12,
        0.6,
      ] as unknown as ExpressionSpecification;

      m.addLayer({
        id: 'alert-outlines-warning',
        type: 'line',
        source: 'alerts',
        filter: warningFilter,
        paint: {
          'line-color': eventColor,
          'line-width': alertWarningWidth,
          'line-opacity': alertWarningOpacity,
        },
      });
      m.addLayer({
        id: 'alert-outlines-watch',
        type: 'line',
        source: 'alerts',
        filter: watchFilter,
        paint: {
          'line-color': eventColor,
          'line-width': alertWatchWidth,
          'line-opacity': alertWatchOpacity,
          'line-dasharray': [2, 2],
        },
      });
      m.addLayer({
        id: 'alert-outlines-advisory',
        type: 'line',
        source: 'alerts',
        filter: advisoryFilter,
        paint: {
          'line-color': eventColor,
          'line-width': alertAdvisoryWidth,
          'line-opacity': alertAdvisoryOpacity,
        },
      });

      // ---------------------------------------------------------------------
      // Confirmed-tornado emphasis (ADDITIVE — does not modify the existing
      // alert fill/outline paint, per SPIKES.md). A bright pulsing ring plus
      // an on-map call-to-action, gated on the flat `tornadoConfirmed`
      // feature property. Radar-indicated tornadoes are deliberately left
      // un-pulsed so the animation itself carries the "confirmed on the
      // ground vs. not" meaning. No fill layer is added, so interior clicks
      // still fall through to `alert-fills-warning` and the popup is
      // unaffected.
      // ---------------------------------------------------------------------
      const confirmedTornadoFilter = [
        '==',
        ['get', 'tornadoConfirmed'],
        true,
      ] as unknown as maplibregl.FilterSpecification;
      const tornadoColorExpr = [
        'get',
        'tornadoColor',
      ] as unknown as maplibregl.ExpressionSpecification;

      // Every tornado polygon — including radar-indicated — gets a
      // category-COLORED border on this parallel layer. The shared
      // event-color expression on alert-outlines-warning is left untouched
      // (SPIKES.md): this is how the four-level magenta ramp reaches the
      // map without editing existing alert paint. Filter is "has a tornado
      // category" so non-tornado alerts are unaffected.
      const tornadoPresentFilter = [
        'has',
        'tornadoColor',
      ] as unknown as maplibregl.FilterSpecification;
      m.addLayer({
        id: 'tornado-cat-outline',
        type: 'line',
        source: 'alerts',
        filter: tornadoPresentFilter,
        paint: {
          'line-color': tornadoColorExpr,
          'line-width': 2.5,
          'line-opacity': 0.95,
        },
      });

      m.addLayer({
        id: 'tornado-confirmed-pulse',
        type: 'line',
        source: 'alerts',
        filter: confirmedTornadoFilter,
        paint: {
          // Pulse rendered in the category color; radar-indicated never
          // reaches this layer (confirmed-only filter) so the static
          // cat-outline above is its sole, un-pulsed treatment.
          'line-color': tornadoColorExpr,
          'line-width': [
            'match',
            ['get', 'tornadoCategory'],
            'EMERGENCY',
            6,
            'PDS',
            5,
            4,
          ] as unknown as maplibregl.ExpressionSpecification,
          // Initial value; the pulse effect animates this when motion is
          // allowed, or pins it static under prefers-reduced-motion.
          'line-opacity': 1,
        },
      });

      m.addLayer({
        id: 'tornado-confirmed-label',
        type: 'symbol',
        source: 'alerts',
        filter: confirmedTornadoFilter,
        layout: {
          'text-field': ['get', 'tornadoAnnotation'],
          // 'Open Sans Semibold' is already used by the storm-motion label
          // layer, so the basemap glyph stack is known to ship it.
          'text-font': ['Open Sans Semibold'],
          'text-size': 13,
          'text-allow-overlap': true,
          'text-letter-spacing': 0.04,
          'text-max-width': 12,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#7f1d1d',
          'text-halo-width': 2,
        },
      });

      // ---------------------------------------------------------------------
      // Storm motion layers
      // ---------------------------------------------------------------------
      //
      // Motion features live on a *separate* source from the alert polygons so
      // the polygon click / hover behavior stays untouched. The source is fed
      // by `renderMotion()`, which runs whenever we fetch a snapshot.
      //
      // Arrow icon is built at runtime on a 32×32 canvas and registered as an
      // SDF image so `icon-color` can tint it per-event — avoids shipping a
      // PNG asset and keeps the arrow in sync with the warning palette.
      m.addSource('alert-motion', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      const arrowSize = 32;
      const arrowCanvas = document.createElement('canvas');
      arrowCanvas.width = arrowSize;
      arrowCanvas.height = arrowSize;
      const arrowCtx = arrowCanvas.getContext('2d');
      if (arrowCtx && !m.hasImage('motion-arrow')) {
        arrowCtx.fillStyle = '#ffffff';
        arrowCtx.beginPath();
        // Triangle points UP (north in MapLibre's rotation convention).
        // icon-rotate with rotation-alignment:'map' then spins it to match the
        // forward bearing stored on each tick feature.
        arrowCtx.moveTo(arrowSize / 2, 2);
        arrowCtx.lineTo(arrowSize - 4, arrowSize - 4);
        arrowCtx.lineTo(4, arrowSize - 4);
        arrowCtx.closePath();
        arrowCtx.fill();
        const imageData = arrowCtx.getImageData(0, 0, arrowSize, arrowSize);
        m.addImage('motion-arrow', imageData, { sdf: true });
      }

      // Dashed forward-projected line out to the 45-minute mark.
      m.addLayer({
        id: 'motion-line',
        type: 'line',
        source: 'alert-motion',
        filter: ['==', ['get', 'kind'], 'line'],
        paint: {
          'line-color': eventColor,
          'line-width': 2,
          'line-opacity': 0.9,
          'line-dasharray': [1, 1],
        },
      });

      // Origin dot — where the radar sees the storm cell right now.
      m.addLayer({
        id: 'motion-origin',
        type: 'circle',
        source: 'alert-motion',
        filter: ['==', ['get', 'kind'], 'origin'],
        paint: {
          'circle-radius': 5,
          'circle-color': eventColor,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      // 15 and 30-minute tick circles (45-min slot is the arrowhead instead).
      m.addLayer({
        id: 'motion-ticks',
        type: 'circle',
        source: 'alert-motion',
        filter: ['all', ['==', ['get', 'kind'], 'tick'], ['!=', ['get', 'tick'], 45]],
        paint: {
          'circle-radius': 3,
          'circle-color': eventColor,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Arrowhead at the 45-min terminus, rotated by forward bearing.
      m.addLayer({
        id: 'motion-head',
        type: 'symbol',
        source: 'alert-motion',
        filter: ['all', ['==', ['get', 'kind'], 'tick'], ['==', ['get', 'tick'], 45]],
        layout: {
          'icon-image': 'motion-arrow',
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-size': 0.5,
          'icon-allow-overlap': true,
        },
        paint: {
          'icon-color': eventColor,
        },
      });

      // Speed label at the 45-minute terminus (e.g. "35 mph"). Text halo keeps
      // the label readable over radar returns + basemap at any zoom. The
      // `label` feature kind is emitted by buildMotionFeatures, co-located
      // with the terminus point; offset up-and-right so it doesn't overlap
      // the arrowhead.
      m.addLayer({
        id: 'motion-label',
        type: 'symbol',
        source: 'alert-motion',
        filter: ['==', ['get', 'kind'], 'label'],
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 12,
          'text-allow-overlap': false,
          'text-variable-anchor': [
            'top',
            'bottom',
            'left',
            'right',
            'top-right',
            'top-left',
            'bottom-right',
            'bottom-left',
          ],
          'text-radial-offset': 1.2,
          'text-justify': 'auto',
          'text-padding': 8,
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1.5,
        },
      });

      // Click / hover must fire for any tier — the popup is tier-agnostic.
      const fillLayerIds = [
        'alert-fills-warning',
        'alert-fills-watch',
        'alert-fills-advisory',
      ] as const;
      for (const layerId of fillLayerIds) {
        m.on('click', layerId, (e) => {
          if (e.features && e.features[0]) {
            setSelectedAlert(e.features[0] as unknown as WeatherAlert);
          }
        });
        m.on('mouseenter', layerId, () => {
          m.getCanvas().style.cursor = 'pointer';
        });
        m.on('mouseleave', layerId, () => {
          m.getCanvas().style.cursor = '';
        });
      }

      setMapReady(true);
    });

    map.current = m;

    return () => {
      m.remove();
    };
  }, []);

  // Pulse the confirmed-tornado ring. The codebase has no animation-loop
  // helper (radar uses native opacity crossfade), so this is a small,
  // self-contained rAF loop with strict teardown. It is a gentle sine ease,
  // deliberately NOT a hard strobe — a strobing polygon in a public-safety
  // app is a photosensitivity hazard. Honors prefers-reduced-motion by
  // pinning a static high-emphasis opacity instead of animating.
  useEffect(() => {
    if (!mapReady) return;
    const LAYER = 'tornado-confirmed-pulse';
    const setOpacity = (v: number) => {
      const m = map.current;
      if (!m || !m.getLayer(LAYER)) return;
      try {
        m.setPaintProperty(LAYER, 'line-opacity', v);
      } catch {
        // Style reloaded between frames — the next frame retries safely.
      }
    };

    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setOpacity(0.95);
      return;
    }

    const MIN = 0.2;
    const MAX = 1;
    const PERIOD_MS = 1100;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const phase = ((now - start) % PERIOD_MS) / PERIOD_MS; // 0..1
      const eased = (1 - Math.cos(phase * 2 * Math.PI)) / 2; // 0..1..0
      setOpacity(MIN + (MAX - MIN) * eased);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mapReady]);

  // Tick `now` every 30s so the "Xm ago" label advances without a full re-fetch.
  // Reads `serverNow()` instead of `Date.now()` so a clock-skewed user sees
  // labels anchored to the server's authoritative time (swarm audit 2026-04-18,
  // Cross-cutting — Time / timezone handling).
  useEffect(() => {
    const interval = setInterval(() => setNow(serverNow()), 30_000);
    return () => clearInterval(interval);
  }, [serverNow]);

  // Label describing what the user is currently viewing. Pure in `now` — the
  // component's ticking state — so React 19's purity lint is satisfied.
  let historicalLabel = 'Live';
  if (isForecast) {
    const forecastDt = new Date(now + forecastOffsetMin * 60_000);
    historicalLabel = `+${forecastOffsetMin}m · ${forecastDt.toLocaleTimeString()}`;
  } else if (!isLive) {
    const entry = history[sliderValue];
    if (entry) {
      const dt = new Date(entry.generated_at);
      const minutesAgo = Math.round((now - dt.getTime()) / 60_000);
      historicalLabel = `${dt.toLocaleTimeString()} (${minutesAgo}m ago)`;
    }
  }

  // Wired into LocationChip: when the user picks/clears a state, update the
  // userState filter (re-derives the views on next fetch via refresh) and
  // pan the map to match. `next.zoom` is an optional hint from the chip —
  // state picks emit ~6 (whole-state view), legacy ZIP saves read back at
  // USER_LOCATION_ZOOM (city-level). Falling back to USER_LOCATION_ZOOM
  // keeps behavior correct for any caller that hasn't been updated yet.
  const handleLocationChange = useCallback(
    (next: { state: string; lat: number; lon: number; zoom?: number } | null) => {
      // Update the ref synchronously BEFORE kicking off the refresh below.
      // The effect that mirrors `userState` -> `userStateRef.current` only runs
      // after the next render, but `refreshCurrentFrameRef.current?.()` reads
      // the ref immediately. Without this line the first refresh after Save
      // runs against the previous filter and renders one frame of wrong data.
      userStateRef.current = next?.state ?? null;
      setUserStateLocal(next?.state ?? null);
      const m = map.current;
      if (m) {
        // Swap the county-line filter to match the newly selected state so
        // county boundaries re-render against the state the user is now
        // looking at. Safe to call before the counties source has loaded —
        // the helper no-ops when the layer isn't on the map yet, and the
        // load handler re-applies the filter against the current ref.
        applyCountyFilter(m, next?.state ?? null);
        if (next) {
          const zoom = next.zoom ?? USER_LOCATION_ZOOM;
          m.flyTo({ center: [next.lon, next.lat], zoom, duration: 800 });
        } else {
          m.flyTo({ center: MIDWEST_CENTER, zoom: MIDWEST_ZOOM, duration: 800 });
        }
      }
      // Force the active frame to re-fetch so filtering takes effect immediately.
      refreshCurrentFrameRef.current?.();
    },
    [],
  );

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Alert count badge — counts ALL active alerts, including zone-aggregate
          products (Watches) that don't render on the map. Previously this
          reflected only polygon features, silently under-reporting Watches. */}
      {allAlerts.length > 0 && (
        <div className="absolute top-[calc(1rem+env(safe-area-inset-top))] left-[calc(1rem+env(safe-area-inset-left))] bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-semibold shadow-lg">
          {allAlerts.length} active alert
          {allAlerts.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Top-left panel stack: active alerts → ZIP filter chip → legend.
          Shared absolute column so the chip and legend naturally flex when
          either accordion expands — opening the LocationChip pushes the
          MapLegend down rather than overlapping it (the prior absolute
          bottom-left positioning of the legend caused the two to drift
          out of visual relationship as the chip grew). All three respect
          the same safe-area insets on notched devices. */}
      <div className="absolute top-[calc(4rem+env(safe-area-inset-top))] left-[calc(1rem+env(safe-area-inset-left))] max-w-[calc(100vw-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] flex flex-col gap-2 items-start">
        {/* Active alerts list — surfaces every alert (polygon + zone-only).
            Critical for Watches and other zone-aggregate products that have
            no geometry and therefore don't appear on the map. Clicking a card
            drives the same selectedAlert popup the map polygons do. */}
        <AlertsPanel
          alerts={allAlerts}
          onSelect={focusAlert}
          selectedId={selectedAlert?.properties.nwsId ?? null}
          now={now}
          userState={userState ?? undefined}
        />

        {/* ZIP-based personalization chip. Collapsible legend-style bubble;
            persists to localStorage. Rendered directly below the alerts panel
            so users find it without it obstructing the map. */}
        <LocationChip onLocationChange={handleLocationChange} />

        {/* Static legend — collapsed by default; explains polygon tiers +
            motion vector glyphs so new users can read the map without an
            onboarding. Sits in the same column as the LocationChip so
            expanding either accordion flexes the other into a clean
            stacked layout. */}
        <MapLegend
          hiddenTiers={hiddenTiers}
          onToggleTier={toggleTier}
          hiddenEvents={hiddenEvents}
          onToggleEvent={toggleEvent}
        />
      </div>

      {/* Historical mode indicator — radar + alerts are NOT current */}
      {!isLive && !isForecast && (
        <div
          className="absolute top-[calc(1rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 bg-amber-500 text-black px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide shadow-lg"
          role="status"
          aria-live="polite"
        >
          HISTORICAL · {historicalLabel}
        </div>
      )}

      {/* Forecast indicator — this is a MODEL projection, not an observation.
          Red-on-black with an explicit "MODEL FORECAST" qualifier so no one
          mistakes HRRR output for an actual NWS warning or live radar return. */}
      {isForecast && (
        <div
          className="absolute top-[calc(1rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 bg-black text-red-400 border border-red-500 px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide shadow-lg"
          role="status"
          aria-live="polite"
        >
          NOWCAST · MODEL FORECAST · {historicalLabel}
        </div>
      )}

      {/* Selected alert detail panel */}
      {selectedAlert &&
        (() => {
          // Mirror the AlertsPanel card via the shared helper so the popup
          // and the side panel cannot drift on multi-state display rules.
          const { areaDesc: selectedAreaDesc, regionalLabel: selectedRegionalLabel } =
            deriveMultiStateDisplay(selectedAlert, userState ?? undefined);
          return (
            <div className="absolute top-[calc(1rem+env(safe-area-inset-top))] right-[calc(4rem+env(safe-area-inset-right))] max-w-sm bg-gray-900/95 text-white rounded-lg shadow-xl p-4 border border-gray-700">
              <button
                onClick={() => setSelectedAlert(null)}
                className="absolute top-2 right-2 text-gray-400 hover:text-white"
                aria-label="Close alert details"
              >
                ✕
              </button>
              <div
                className="text-xs font-bold uppercase tracking-wide mb-1"
                style={{
                  color:
                    selectedAlert.properties.tornadoColor ??
                    colorForEvent(selectedAlert.properties.event),
                }}
                title={selectedAlert.properties.tornadoLabelTitle}
              >
                {selectedAlert.properties.tornadoLabel ?? selectedAlert.properties.event}
              </div>
              <div className="text-sm font-semibold mb-2">{selectedAlert.properties.headline}</div>
              <div className="text-xs text-gray-300 mb-2">{selectedAreaDesc}</div>
              {selectedRegionalLabel && (
                <div className="text-[10px] text-gray-400 mb-2">{selectedRegionalLabel}</div>
              )}
              <div className="text-xs text-gray-400 max-h-40 overflow-y-auto">
                {selectedAlert.properties.description}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                Expires: {new Date(selectedAlert.properties.expires).toLocaleString()}
              </div>
            </div>
          );
        })()}

      {/* Time slider + status bar */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/85 via-black/60 to-transparent p-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pointer-events-none">
        <div className="max-w-4xl mx-auto space-y-2 pointer-events-auto">
          {history.length > 0 && (
            <>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setIsPlaying(false);
                    setSliderValue(history.length);
                  }}
                  disabled={isLive}
                  className={`text-xs font-semibold px-2 py-1 rounded shrink-0 transition-colors ${
                    isLive
                      ? 'bg-red-600 text-white cursor-default'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700 cursor-pointer'
                  }`}
                  aria-label="Return to live"
                >
                  {isLive ? '● LIVE' : 'Go to LIVE'}
                </button>

                <input
                  type="range"
                  min={0}
                  max={sliderMax}
                  value={sliderValue}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setSliderValue(Number(e.target.value));
                  }}
                  className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gray-700 accent-red-500"
                  aria-label="Scrub through history, live, and forecast"
                />

                <div className="text-xs text-gray-300 font-mono shrink-0 w-44 text-right">
                  {historicalLabel}
                </div>
              </div>

              {/* Playback row — step / play / speed, plus a frame counter so
                  it's obvious each tick advances even when the scene is calm. */}
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={stepBack}
                  disabled={sliderValue === 0}
                  className="px-2 py-1 rounded bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Step back one frame"
                  title="Step back"
                >
                  ⏮
                </button>
                <button
                  onClick={togglePlay}
                  disabled={history.length < 2}
                  className="px-2 py-1 rounded bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed w-8 text-center"
                  aria-label={isPlaying ? 'Pause playback' : 'Play time-lapse'}
                  title={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
                <button
                  onClick={stepForward}
                  disabled={sliderValue >= sliderMax}
                  className="px-2 py-1 rounded bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Step forward one frame"
                  title="Step forward"
                >
                  ⏭
                </button>

                <div
                  className="flex items-center gap-1 ml-2"
                  role="radiogroup"
                  aria-label="Playback speed"
                >
                  {([1, 2, 4] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setPlaySpeed(s)}
                      role="radio"
                      aria-checked={playSpeed === s}
                      className={`px-1.5 py-0.5 rounded font-mono ${
                        playSpeed === s
                          ? 'bg-red-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>

                <div className="ml-auto font-mono text-gray-400">
                  Frame {sliderValue + 1}/{sliderMax + 1}
                </div>
              </div>
            </>
          )}

          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span>
              {snapshotTime
                ? `Snapshot ${snapshotTime.toLocaleTimeString()}`
                : 'Waiting for snapshot…'}
            </span>
            {history.length > 0 && (
              <span>
                {history.length} snapshot{history.length !== 1 ? 's' : ''} in history
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
