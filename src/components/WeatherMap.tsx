'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { radarTileUrl } from '@/lib/radar';

// Warning color map by NWS event type
const WARNING_COLORS: Record<string, string> = {
  'Tornado Warning': '#FF0000',
  'Tornado Watch': '#FFFF00',
  'Severe Thunderstorm Warning': '#FFA500',
  'Severe Thunderstorm Watch': '#DB7093',
  'Flash Flood Warning': '#8B0000',
  'Flash Flood Watch': '#2E8B57',
  'Special Weather Statement': '#FFE4B5',
};

const WARNING_PRIORITY: Record<string, number> = {
  'Tornado Warning': 0,
  'Severe Thunderstorm Warning': 1,
  'Flash Flood Warning': 2,
  'Tornado Watch': 3,
  'Severe Thunderstorm Watch': 4,
  'Flash Flood Watch': 5,
  'Special Weather Statement': 6,
};

// Wisconsin center coordinates
const WISCONSIN_CENTER: [number, number] = [-89.5, 44.5];
const DEFAULT_ZOOM = 7;

// ---------------------------------------------------------------------------
// Types matching the Worker + ingest contract
// ---------------------------------------------------------------------------

// Map-internal shape (kept stable because all MapLibre render logic uses it).
interface WeatherAlert {
  type: 'Feature';
  properties: {
    event: string;
    headline: string;
    description: string;
    severity: string;
    urgency: string;
    effective: string;
    expires: string;
    senderName: string;
    areaDesc: string;
  };
  geometry: GeoJSON.Geometry | null;
}

interface AlertsResponse {
  type: 'FeatureCollection';
  features: WeatherAlert[];
}

// Ingest snapshot shape (from seestorm-ingest internal/publisher.Snapshot).
// Intentionally different from the map-internal shape — we translate below.
interface IngestAlert {
  nws_id: string;
  event_type: string;
  severity: string;
  headline: string;
  description: string;
  area_desc: string;
  geometry: GeoJSON.Geometry | null;
  effective_at: string;
  expires_at: string;
}

interface IngestSnapshot {
  generated_at: string;
  area: string;
  alert_count: number;
  alerts: IngestAlert[];
}

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
// Snapshot transform
// ---------------------------------------------------------------------------

function snapshotToFeatures(snapshot: IngestSnapshot): AlertsResponse {
  const features: WeatherAlert[] = snapshot.alerts
    .filter((a): a is IngestAlert & { geometry: GeoJSON.Geometry } => a.geometry !== null)
    .sort((a, b) => (WARNING_PRIORITY[a.event_type] ?? 99) - (WARNING_PRIORITY[b.event_type] ?? 99))
    .map((a) => ({
      type: 'Feature',
      properties: {
        event: a.event_type,
        headline: a.headline,
        description: a.description,
        severity: a.severity,
        urgency: '',
        effective: a.effective_at,
        expires: a.expires_at,
        senderName: '',
        areaDesc: a.area_desc,
      },
      geometry: a.geometry,
    }));

  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WeatherMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
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

  const isLive = history.length === 0 || sliderValue === history.length;

  // Paint a FeatureCollection onto the map's alerts source.
  const renderFeatures = useCallback((features: AlertsResponse) => {
    if (!map.current?.getSource('alerts')) return;
    (map.current.getSource('alerts') as maplibregl.GeoJSONSource).setData(
      features as unknown as GeoJSON.FeatureCollection,
    );
  }, []);

  // Fetch the live snapshot (/v1/active-events.json) — used when sliderValue is live.
  const fetchLive = useCallback(async () => {
    try {
      const response = await fetch('/v1/active-events.json');
      if (!response.ok) return;
      const snapshot: IngestSnapshot = await response.json();
      const features = snapshotToFeatures(snapshot);
      setAlerts(features);
      setSnapshotTime(new Date(snapshot.generated_at));
      renderFeatures(features);
    } catch (err) {
      console.error('Failed to fetch live snapshot:', err);
    }
  }, [renderFeatures]);

  // Fetch one historical snapshot by timestamp key.
  const fetchHistorical = useCallback(
    async (ts: string) => {
      try {
        const response = await fetch(`/v1/history/${ts}`);
        if (!response.ok) return;
        const snapshot: IngestSnapshot = await response.json();
        const features = snapshotToFeatures(snapshot);
        setAlerts(features);
        setSnapshotTime(new Date(snapshot.generated_at));
        renderFeatures(features);
      } catch (err) {
        console.error('Failed to fetch historical snapshot:', err);
      }
    },
    [renderFeatures],
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
        // Wrap from last historical frame back to oldest; never enter live mode
        // via playback — users click "Go to LIVE" explicitly for that.
        if (v >= history.length - 1) return 0;
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
    setSliderValue((v) => Math.min(history.length, v + 1));
  }, [history.length]);

  // Swap the radar tile source to match slider state. MapLibre does not reliably
  // update a raster source's `tiles` URL in place — the stock pattern is to
  // remove the layer + source and re-create them. We keep the new radar layer
  // below `alert-fills` so alert polygons stay on top.
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const m = map.current;

    let url: string;
    if (isLive) {
      url = radarTileUrl('live');
    } else {
      const entry = history[sliderValue];
      if (!entry) return;
      url = radarTileUrl(new Date(entry.generated_at));
    }

    if (m.getLayer('radar-layer')) m.removeLayer('radar-layer');
    if (m.getSource('radar')) m.removeSource('radar');

    m.addSource('radar', {
      type: 'raster',
      tiles: [url],
      tileSize: 256,
      attribution: 'NEXRAD via Iowa Environmental Mesonet',
    });
    m.addLayer(
      {
        id: 'radar-layer',
        type: 'raster',
        source: 'radar',
        paint: { 'raster-opacity': 0.6 },
      },
      'alert-fills',
    );
  }, [mapReady, isLive, sliderValue, history]);

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
      m.addSource('radar', {
        type: 'raster',
        tiles: [radarTileUrl('live')],
        tileSize: 256,
        attribution: 'NEXRAD via Iowa Environmental Mesonet',
      });

      m.addLayer({
        id: 'radar-layer',
        type: 'raster',
        source: 'radar',
        paint: {
          'raster-opacity': 0.6,
        },
      });

      m.addSource('alerts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      m.addLayer({
        id: 'alert-fills',
        type: 'fill',
        source: 'alerts',
        paint: {
          'fill-color': [
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
          ],
          'fill-opacity': 0.25,
        },
      });

      m.addLayer({
        id: 'alert-outlines',
        type: 'line',
        source: 'alerts',
        paint: {
          'line-color': [
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
          ],
          'line-width': 2,
          'line-opacity': 0.8,
        },
      });

      m.on('click', 'alert-fills', (e) => {
        if (e.features && e.features[0]) {
          setSelectedAlert(e.features[0] as unknown as WeatherAlert);
        }
      });

      m.on('mouseenter', 'alert-fills', () => {
        m.getCanvas().style.cursor = 'pointer';
      });

      m.on('mouseleave', 'alert-fills', () => {
        m.getCanvas().style.cursor = '';
      });

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
  if (!isLive) {
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

      {/* Alert count badge */}
      {alerts && alerts.features.length > 0 && (
        <div className="absolute top-4 left-4 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-semibold shadow-lg">
          {alerts.features.length} active alert
          {alerts.features.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Historical mode indicator — radar + alerts are NOT current */}
      {!isLive && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-amber-500 text-black px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide shadow-lg"
          role="status"
          aria-live="polite"
        >
          HISTORICAL · {historicalLabel}
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
              color: WARNING_COLORS[selectedAlert.properties.event] ?? '#888888',
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
                  max={history.length}
                  value={sliderValue}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setSliderValue(Number(e.target.value));
                  }}
                  className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gray-700 accent-red-500"
                  aria-label="Scrub through snapshot history"
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
                  disabled={isLive || sliderValue === 0}
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
                  disabled={sliderValue >= history.length}
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
                  Frame {isLive ? history.length : sliderValue + 1}/{history.length}
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
