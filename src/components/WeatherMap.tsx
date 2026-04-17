'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { radarTileUrl, hrrrTileUrl, HRRR_STEP_MINUTES, HRRR_FRAME_COUNT } from '@/lib/radar';
import { buildMotionFeatures, setMotionVisibility } from '@/lib/stormMotion';
import {
  buildAlertViews,
  WARNING_COLORS,
  colorForEvent,
  type AlertsResponse,
  type IngestSnapshot,
  type IngestAlert,
  type WeatherAlert,
} from '@/lib/alerts';
import AlertsPanel from './AlertsPanel';
import MapLegend from './MapLegend';

// Wisconsin center coordinates
const WISCONSIN_CENTER: [number, number] = [-89.5, 44.5];
const DEFAULT_ZOOM = 7;

// Radar animation tuning. These values balance responsiveness (slider feels
// immediate) against smoothness (no visible popping during playback).
const RADAR_OPACITY = 0.6;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WeatherMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // Which radar layer is currently on top (fully visible). The other is the
  // staging layer — we load the next URL into it, then crossfade.
  const activeRadar = useRef<'a' | 'b'>('a');

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
  // `now` is a ticking reference time used only for rendering "Xm ago" labels.
  // Kept in state (not read directly via Date.now() in render) so React 19's
  // purity lint stays happy and re-renders only fire at the cadence we choose.
  const [now, setNow] = useState<number>(() => Date.now());

  // Slider range is: 0 .. history.length-1 (historical)
  //                  history.length (live)
  //                  history.length+1 .. history.length+HRRR_FRAME_COUNT (forecast)
  const sliderMax = history.length + HRRR_FRAME_COUNT;
  const isForecast = sliderValue > history.length;
  const isLive = !isForecast && (history.length === 0 || sliderValue === history.length);
  // Minutes ahead of now for the current forecast frame (0 when not forecasting).
  const forecastOffsetMin = isForecast ? (sliderValue - history.length) * HRRR_STEP_MINUTES : 0;

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

  // Fetch the live snapshot (/v1/active-events.json) — used when sliderValue is live.
  const fetchLive = useCallback(async () => {
    try {
      const response = await fetch('/v1/active-events.json');
      if (!response.ok) return;
      const snapshot: IngestSnapshot = await response.json();
      const { mapFeatures, listAlerts } = buildAlertViews(snapshot);
      setAllAlerts(listAlerts);
      setSnapshotTime(new Date(snapshot.generated_at));
      renderFeatures(mapFeatures);
      renderMotion(snapshot.alerts);
    } catch (err) {
      console.error('Failed to fetch live snapshot:', err);
    }
  }, [renderFeatures, renderMotion]);

  // Fetch one historical snapshot by timestamp key.
  const fetchHistorical = useCallback(
    async (ts: string) => {
      try {
        const response = await fetch(`/v1/history/${ts}`);
        if (!response.ok) return;
        const snapshot: IngestSnapshot = await response.json();
        const { mapFeatures, listAlerts } = buildAlertViews(snapshot);
        setAllAlerts(listAlerts);
        setSnapshotTime(new Date(snapshot.generated_at));
        renderFeatures(mapFeatures);
        renderMotion(snapshot.alerts);
      } catch (err) {
        console.error('Failed to fetch historical snapshot:', err);
      }
    },
    [renderFeatures, renderMotion],
  );

  // Fetch the history index from the Worker.
  const fetchHistory = useCallback(async () => {
    try {
      const response = await fetch('/v1/history?limit=60');
      if (!response.ok) return;
      const data: HistoryResponse = await response.json();
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
      console.error('Failed to fetch history index:', err);
    }
  }, [sliderValue]);

  // When in live mode, poll live + refresh history list every 30s.
  // fetchLive/fetchHistory are async — setState happens after `await`, not
  // synchronously in this effect body — so react-hooks/set-state-in-effect
  // is a false positive here.
  useEffect(() => {
    if (!mapReady || !isLive) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setState post-await
    void fetchLive();

    void fetchHistory();
    const interval = setInterval(() => {
      void fetchLive();
      void fetchHistory();
    }, 30_000);
    return () => clearInterval(interval);
  }, [mapReady, isLive, fetchLive, fetchHistory]);

  // When scrubbed to historical, fetch that snapshot. Same async-setState pattern.
  useEffect(() => {
    if (!mapReady || isLive) return;
    const entry = history[sliderValue];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setState post-await
    if (entry) void fetchHistorical(entry.ts);
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
    m.setPaintProperty(incomingLayerId, 'raster-opacity', RADAR_OPACITY);
    m.setPaintProperty(currentLayerId, 'raster-opacity', 0);

    activeRadar.current = incoming;

    // Alerts are observations of what IS happening; they have no meaning for
    // future frames. Hide the tiered alert layers entirely in forecast mode
    // so users can't confuse a model projection with an NWS warning.
    const alertVisibility = isForecast ? 'none' : 'visible';
    const alertLayerIds = [
      'alert-fills-warning',
      'alert-fills-watch',
      'alert-fills-advisory',
      'alert-outlines-warning',
      'alert-outlines-watch',
      'alert-outlines-advisory',
    ];
    for (const layerId of alertLayerIds) {
      if (m.getLayer(layerId)) m.setLayoutProperty(layerId, 'visibility', alertVisibility);
    }
    // Motion layers follow the same gating — a motion vector is an observation
    // of a storm's current velocity, which has no meaning when the user has
    // scrubbed into a model forecast frame. Driven from MOTION_LAYER_IDS so
    // adding a new motion layer automatically stays hooked up.
    setMotionVisibility(m, !isForecast);
  }, [mapReady, isLive, isForecast, forecastOffsetMin, sliderValue, history]);

  // Map init.
  useEffect(() => {
    if (!mapContainer.current) return;

    // Basemap style: defaults to CartoDB Dark Matter (free, no-key, works from any
    // origin, and matches the dark SeeStorm theme). Override via NEXT_PUBLIC_MAP_STYLE_URL
    // when self-hosting Protomaps on R2 or using a keyed Stadia Maps style.
    const mapStyle =
      process.env.NEXT_PUBLIC_MAP_STYLE_URL ||
      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: mapStyle,
      center: WISCONSIN_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: {},
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
          'raster-opacity': RADAR_OPACITY,
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

      // County lines — drawn first (below state lines) so state borders win
      // visually when they coincide with a county edge at a state boundary.
      m.addLayer({
        id: 'admin-counties-line',
        type: 'line',
        source: 'admin-counties',
        paint: {
          'line-color': '#6b7280',
          'line-width': 0.6,
          'line-opacity': 0.35,
        },
      });
      m.addLayer({
        id: 'admin-states-line',
        type: 'line',
        source: 'admin-states',
        paint: {
          'line-color': '#9ca3af',
          'line-width': 1.2,
          'line-opacity': 0.55,
        },
      });

      // Populate boundary sources asynchronously. Failures here are
      // non-critical — the map still works without boundary lines.
      void (async () => {
        try {
          const [statesRes, countiesRes] = await Promise.all([
            fetch('/geo/us-states.geojson'),
            fetch('/geo/wi-counties.geojson'),
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
        '#888888',
      ];

      // Tier classification happens entirely inside MapLibre filters —
      // suffix-match the `event` string so new NWS event types are placed
      // into the correct tier without any JS preprocessing.
      //   Warning  → ends with " Warning"  → bold, saturated fill (take shelter)
      //   Watch    → ends with " Watch"    → dashed outline, faint fill (be aware)
      //   Advisory → everything else       → thin outline, near-transparent fill (monitor)
      const warningFilter: maplibregl.FilterSpecification = [
        '==',
        ['slice', ['get', 'event'], -8],
        ' Warning',
      ];
      const watchFilter: maplibregl.FilterSpecification = [
        '==',
        ['slice', ['get', 'event'], -6],
        ' Watch',
      ];
      // Fallback tier: whatever isn't a Warning or a Watch.
      const advisoryFilter: maplibregl.FilterSpecification = [
        'all',
        ['!=', ['slice', ['get', 'event'], -8], ' Warning'],
        ['!=', ['slice', ['get', 'event'], -6], ' Watch'],
      ];

      // Fills — opacity is the primary signal of urgency.
      m.addLayer({
        id: 'alert-fills-warning',
        type: 'fill',
        source: 'alerts',
        filter: warningFilter,
        paint: { 'fill-color': eventColor, 'fill-opacity': 0.2 },
      });
      m.addLayer({
        id: 'alert-fills-watch',
        type: 'fill',
        source: 'alerts',
        filter: watchFilter,
        paint: { 'fill-color': eventColor, 'fill-opacity': 0.12 },
      });
      m.addLayer({
        id: 'alert-fills-advisory',
        type: 'fill',
        source: 'alerts',
        filter: advisoryFilter,
        paint: { 'fill-color': eventColor, 'fill-opacity': 0.06 },
      });

      // Outlines — line weight + dash pattern reinforce the tier.
      m.addLayer({
        id: 'alert-outlines-warning',
        type: 'line',
        source: 'alerts',
        filter: warningFilter,
        paint: { 'line-color': eventColor, 'line-width': 3, 'line-opacity': 0.9 },
      });
      m.addLayer({
        id: 'alert-outlines-watch',
        type: 'line',
        source: 'alerts',
        filter: watchFilter,
        paint: {
          'line-color': eventColor,
          'line-width': 2,
          'line-opacity': 0.75,
          'line-dasharray': [2, 2],
        },
      });
      m.addLayer({
        id: 'alert-outlines-advisory',
        type: 'line',
        source: 'alerts',
        filter: advisoryFilter,
        paint: { 'line-color': eventColor, 'line-width': 1.5, 'line-opacity': 0.6 },
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
          'text-size': 11,
          'text-offset': [0.8, -0.8],
          'text-anchor': 'bottom-left',
          'text-allow-overlap': true,
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

  // Tick `now` every 30s so the "Xm ago" label advances without a full re-fetch.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

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

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Alert count badge — counts ALL active alerts, including zone-aggregate
          products (Watches) that don't render on the map. Previously this
          reflected only polygon features, silently under-reporting Watches. */}
      {allAlerts.length > 0 && (
        <div className="absolute top-4 left-4 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-semibold shadow-lg">
          {allAlerts.length} active alert
          {allAlerts.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Active alerts list — surfaces every alert (polygon + zone-only).
          Critical for Watches and other zone-aggregate products that have
          no geometry and therefore don't appear on the map. Clicking a card
          drives the same selectedAlert popup the map polygons do. */}
      <AlertsPanel
        alerts={allAlerts}
        onSelect={setSelectedAlert}
        selectedId={selectedAlert?.properties.nwsId ?? null}
        now={now}
      />

      {/* Static legend — collapsed by default; explains polygon tiers + motion
          vector glyphs so new users can read the map without an onboarding. */}
      <MapLegend />

      {/* Historical mode indicator — radar + alerts are NOT current */}
      {!isLive && !isForecast && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-amber-500 text-black px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide shadow-lg"
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
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-black text-red-400 border border-red-500 px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide shadow-lg"
          role="status"
          aria-live="polite"
        >
          NOWCAST · MODEL FORECAST · {historicalLabel}
        </div>
      )}

      {/* Selected alert detail panel */}
      {selectedAlert && (
        <div className="absolute top-4 right-16 max-w-sm bg-gray-900/95 text-white rounded-lg shadow-xl p-4 border border-gray-700">
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
              color: colorForEvent(selectedAlert.properties.event),
            }}
          >
            {selectedAlert.properties.event}
          </div>
          <div className="text-sm font-semibold mb-2">{selectedAlert.properties.headline}</div>
          <div className="text-xs text-gray-300 mb-2">{selectedAlert.properties.areaDesc}</div>
          <div className="text-xs text-gray-400 max-h-40 overflow-y-auto">
            {selectedAlert.properties.description}
          </div>
          <div className="text-xs text-gray-500 mt-2">
            Expires: {new Date(selectedAlert.properties.expires).toLocaleString()}
          </div>
        </div>
      )}

      {/* Time slider + status bar */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/85 via-black/60 to-transparent p-4 pb-5 pointer-events-none">
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
