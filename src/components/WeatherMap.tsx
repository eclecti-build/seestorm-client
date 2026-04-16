"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// Warning color map by NWS event type
const WARNING_COLORS: Record<string, string> = {
  "Tornado Warning": "#FF0000",
  "Tornado Watch": "#FFFF00",
  "Severe Thunderstorm Warning": "#FFA500",
  "Severe Thunderstorm Watch": "#DB7093",
  "Flash Flood Warning": "#8B0000",
  "Flash Flood Watch": "#2E8B57",
  "Special Weather Statement": "#FFE4B5",
};

const WARNING_PRIORITY: Record<string, number> = {
  "Tornado Warning": 0,
  "Severe Thunderstorm Warning": 1,
  "Flash Flood Warning": 2,
  "Tornado Watch": 3,
  "Severe Thunderstorm Watch": 4,
  "Flash Flood Watch": 5,
  "Special Weather Statement": 6,
};

// Wisconsin center coordinates
const WISCONSIN_CENTER: [number, number] = [-89.5, 44.5];
const DEFAULT_ZOOM = 7;

interface WeatherAlert {
  type: "Feature";
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
  type: "FeatureCollection";
  features: WeatherAlert[];
}

export default function WeatherMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<WeatherAlert | null>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const response = await fetch(
        "https://api.weather.gov/alerts/active?area=WI&status=actual",
        {
          headers: {
            "User-Agent": "(seestorm.org, contact@seestorm.org)",
          },
        }
      );
      if (!response.ok) return;

      const data: AlertsResponse = await response.json();

      // Filter to only features with geometry and sort by priority
      const withGeometry = data.features
        .filter((f) => f.geometry !== null)
        .sort(
          (a, b) =>
            (WARNING_PRIORITY[a.properties.event] ?? 99) -
            (WARNING_PRIORITY[b.properties.event] ?? 99)
        );

      const filtered: AlertsResponse = {
        type: "FeatureCollection",
        features: withGeometry,
      };

      setAlerts(filtered);
      setLastUpdated(new Date());

      // Update map source if it exists
      if (map.current?.getSource("alerts")) {
        (map.current.getSource("alerts") as maplibregl.GeoJSONSource).setData(
          filtered as unknown as GeoJSON.FeatureCollection
        );
      }
    } catch (err) {
      console.error("Failed to fetch alerts:", err);
    }
  }, []);

  useEffect(() => {
    if (!mapContainer.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json",
      center: WISCONSIN_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: {},
    });

    m.addControl(new maplibregl.NavigationControl(), "top-right");
    m.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "top-right"
    );

    m.on("load", () => {
      // Add radar overlay from Iowa Mesonet
      m.addSource("radar", {
        type: "raster",
        tiles: [
          "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "NEXRAD via Iowa Environmental Mesonet",
      });

      m.addLayer({
        id: "radar-layer",
        type: "raster",
        source: "radar",
        paint: {
          "raster-opacity": 0.6,
        },
      });

      // Add alerts source (empty initially)
      m.addSource("alerts", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Warning polygon fills
      m.addLayer({
        id: "alert-fills",
        type: "fill",
        source: "alerts",
        paint: {
          "fill-color": [
            "match",
            ["get", "event"],
            "Tornado Warning",
            WARNING_COLORS["Tornado Warning"],
            "Tornado Watch",
            WARNING_COLORS["Tornado Watch"],
            "Severe Thunderstorm Warning",
            WARNING_COLORS["Severe Thunderstorm Warning"],
            "Severe Thunderstorm Watch",
            WARNING_COLORS["Severe Thunderstorm Watch"],
            "Flash Flood Warning",
            WARNING_COLORS["Flash Flood Warning"],
            "Flash Flood Watch",
            WARNING_COLORS["Flash Flood Watch"],
            "#888888",
          ],
          "fill-opacity": 0.25,
        },
      });

      // Warning polygon outlines
      m.addLayer({
        id: "alert-outlines",
        type: "line",
        source: "alerts",
        paint: {
          "line-color": [
            "match",
            ["get", "event"],
            "Tornado Warning",
            WARNING_COLORS["Tornado Warning"],
            "Tornado Watch",
            WARNING_COLORS["Tornado Watch"],
            "Severe Thunderstorm Warning",
            WARNING_COLORS["Severe Thunderstorm Warning"],
            "Severe Thunderstorm Watch",
            WARNING_COLORS["Severe Thunderstorm Watch"],
            "Flash Flood Warning",
            WARNING_COLORS["Flash Flood Warning"],
            "Flash Flood Watch",
            WARNING_COLORS["Flash Flood Watch"],
            "#888888",
          ],
          "line-width": 2,
          "line-opacity": 0.8,
        },
      });

      // Click handler for alert polygons
      m.on("click", "alert-fills", (e) => {
        if (e.features && e.features[0]) {
          setSelectedAlert(e.features[0] as unknown as WeatherAlert);
        }
      });

      m.on("mouseenter", "alert-fills", () => {
        m.getCanvas().style.cursor = "pointer";
      });

      m.on("mouseleave", "alert-fills", () => {
        m.getCanvas().style.cursor = "";
      });

      // Fetch alerts immediately and then every 30 seconds
      fetchAlerts();
    });

    map.current = m;

    const interval = setInterval(fetchAlerts, 30_000);

    return () => {
      clearInterval(interval);
      m.remove();
    };
  }, [fetchAlerts]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />

      {/* Alert count badge */}
      {alerts && alerts.features.length > 0 && (
        <div className="absolute top-4 left-4 bg-red-600 text-white px-3 py-1.5 rounded-lg text-sm font-semibold shadow-lg">
          {alerts.features.length} active alert
          {alerts.features.length !== 1 ? "s" : ""}
        </div>
      )}

      {/* Last updated timestamp */}
      {lastUpdated && (
        <div className="absolute bottom-4 left-4 bg-black/70 text-white/70 px-2 py-1 rounded text-xs">
          Updated {lastUpdated.toLocaleTimeString()}
        </div>
      )}

      {/* Selected alert detail panel */}
      {selectedAlert && (
        <div className="absolute top-4 right-16 max-w-sm bg-gray-900/95 text-white rounded-lg shadow-xl p-4 border border-gray-700">
          <button
            onClick={() => setSelectedAlert(null)}
            className="absolute top-2 right-2 text-gray-400 hover:text-white"
          >
            ✕
          </button>
          <div
            className="text-xs font-bold uppercase tracking-wide mb-1"
            style={{
              color:
                WARNING_COLORS[selectedAlert.properties.event] ?? "#888888",
            }}
          >
            {selectedAlert.properties.event}
          </div>
          <div className="text-sm font-semibold mb-2">
            {selectedAlert.properties.headline}
          </div>
          <div className="text-xs text-gray-300 mb-2">
            {selectedAlert.properties.areaDesc}
          </div>
          <div className="text-xs text-gray-400 max-h-40 overflow-y-auto">
            {selectedAlert.properties.description}
          </div>
          <div className="text-xs text-gray-500 mt-2">
            Expires:{" "}
            {new Date(selectedAlert.properties.expires).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}
