'use client';

import { useEffect, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { REGIONS, type RegionId } from '@/lib/regions';
import {
  projectContiguous,
  regionBounds,
  regionViewBox,
  type ProjectedMap,
} from '@/lib/usProjection';

// Muted "atlas on midnight" palette: seven hues at similar chroma/lightness so
// the map reads as one designed system rather than a rainbow, while staying
// distinguishable on the deep-navy app background. The Great Lakes home turf
// borrows the brand's lake-blue.
export const REGION_THEME: Readonly<Record<RegionId, string>> = Object.freeze({
  west: '#4f8a8b',
  mountain: '#8b7fb0',
  plains: '#c6a15b',
  midwest: '#3f9fce',
  south: '#cf8169',
  midatlantic: '#6f8fd4',
  newengland: '#67a87f',
});

const GEOJSON_URL = '/geo/us-states.geojson';

// Module-scoped cache: the projection is deterministic and the asset is tiny,
// so parse it once and hand every later chip-open an instant map.
let projectionCache: ProjectedMap | null = null;
let projectionInflight: Promise<ProjectedMap> | null = null;

function loadProjection(): Promise<ProjectedMap> {
  if (projectionCache) return Promise.resolve(projectionCache);
  if (!projectionInflight) {
    projectionInflight = (async () => {
      const res = await fetch(GEOJSON_URL);
      if (!res.ok) throw new Error(`states geojson ${res.status}`);
      const json = (await res.json()) as FeatureCollection;
      projectionCache = projectContiguous(json);
      return projectionCache;
    })().catch((err) => {
      // Allow a later open to retry a transient failure.
      projectionInflight = null;
      throw err;
    });
  }
  return projectionInflight;
}

/** Lazily load + project the states GeoJSON once the picker is opened. */
function useProjection(enabled: boolean): ProjectedMap | null {
  const [map, setMap] = useState<ProjectedMap | null>(projectionCache);
  useEffect(() => {
    if (!enabled || map) return;
    let active = true;
    loadProjection()
      .then((m) => {
        if (active) setMap(m);
      })
      .catch(() => {
        // Falls back to region tiles — handled by the caller.
      });
    return () => {
      active = false;
    };
  }, [enabled, map]);
  return map;
}

interface UsRegionMapProps {
  /** Whether the picker is open — gates the lazy GeoJSON fetch. */
  active: boolean;
  /** Region containing the user's current selection, highlighted persistently. */
  activeRegion: RegionId | null;
  onPickRegion: (id: RegionId) => void;
}

export default function UsRegionMap({ active, activeRegion, onPickRegion }: UsRegionMapProps) {
  const projected = useProjection(active);
  const [hovered, setHovered] = useState<RegionId | null>(null);

  const focusRegion = hovered ?? activeRegion;
  const focusLabel = focusRegion ? REGIONS.find((r) => r.id === focusRegion) : null;

  return (
    <div>
      {projected ? (
        <SvgMap
          projected={projected}
          hovered={hovered}
          activeRegion={activeRegion}
          onHover={setHovered}
          onPickRegion={onPickRegion}
        />
      ) : (
        <RegionTiles
          hovered={hovered}
          activeRegion={activeRegion}
          onHover={setHovered}
          onPickRegion={onPickRegion}
        />
      )}

      <p className="mt-1.5 text-[11px] leading-tight min-h-[2.1em]">
        {focusLabel ? (
          <>
            <span className="font-semibold text-white">{focusLabel.label}</span>
            <span className="text-gray-400"> · {focusLabel.blurb}</span>
          </>
        ) : (
          <span className="text-gray-500">Tap a region to dial in your state.</span>
        )}
      </p>
    </div>
  );
}

interface MapInnerProps {
  hovered: RegionId | null;
  activeRegion: RegionId | null;
  onHover: (id: RegionId | null) => void;
  onPickRegion: (id: RegionId) => void;
}

function SvgMap({
  projected,
  hovered,
  activeRegion,
  onHover,
  onPickRegion,
}: MapInnerProps & {
  projected: ProjectedMap;
}) {
  // Group projected features by region so each region is a single control.
  const groups = REGIONS.map((region) => ({
    region,
    features: projected.features.filter((f) => f.region === region.id),
  }));

  return (
    <div
      className="relative rounded-md overflow-hidden ring-1 ring-white/10"
      style={{
        background: 'radial-gradient(120% 120% at 50% 0%, #131c2e 0%, #0a0f1a 70%)',
      }}
    >
      <svg
        viewBox={`0 0 ${projected.width} ${projected.height}`}
        className="w-full h-auto block"
        role="group"
        aria-label="Map of US regions"
      >
        {groups.map(({ region, features }) => {
          const isFocused = hovered === region.id || activeRegion === region.id;
          const dimmed = hovered !== null && hovered !== region.id;
          const base = REGION_THEME[region.id];
          return (
            <g
              key={region.id}
              role="button"
              tabIndex={0}
              aria-label={`${region.label} region`}
              aria-pressed={activeRegion === region.id}
              onClick={() => onPickRegion(region.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPickRegion(region.id);
                }
              }}
              onMouseEnter={() => onHover(region.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(region.id)}
              onBlur={() => onHover(null)}
              className="cursor-pointer outline-none transition-opacity duration-150"
              style={{
                opacity: dimmed ? 0.4 : 1,
                filter: isFocused
                  ? 'brightness(1.22) drop-shadow(0 0 4px rgba(125,211,252,0.55))'
                  : undefined,
              }}
            >
              {features.map((f) => (
                <path
                  key={f.code}
                  d={f.d}
                  fill={base}
                  stroke={isFocused ? '#e8eefc' : '#0a0f1a'}
                  strokeWidth={isFocused ? 2 : 1.1}
                  strokeLinejoin="round"
                />
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface RegionStateMapProps {
  /** Gates the lazy GeoJSON fetch (the picker being open). */
  active: boolean;
  region: RegionId;
  selectedState: string | null;
  onPick: (code: string) => void;
}

/**
 * Zoomed map of a single region's states, each individually selectable — the
 * map half of the drill-down (the state chips are the other half). Reuses the
 * module-cached projection, so it appears instantly after the region map has
 * loaded. Renders nothing if the projection isn't available yet, so the caller
 * still shows the chips as the always-present fallback.
 */
export function RegionStateMap({ active, region, selectedState, onPick }: RegionStateMapProps) {
  const projected = useProjection(active);
  const [hovered, setHovered] = useState<string | null>(null);

  if (!projected) return null;
  const viewBox = regionViewBox(projected.features, region);
  const box = regionBounds(projected.features, region);
  if (!viewBox || !box) return null;

  const members = projected.features.filter((f) => f.region === region);
  const accent = REGION_THEME[region];
  const label = REGIONS.find((r) => r.id === region)?.label ?? region;
  // Size labels/strokes off the framed region so codes stay legible whether the
  // region is a tall strip (Plains) or a tight cluster (New England).
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  const labelSize = span * 0.05;

  return (
    <div
      className="rounded-md overflow-hidden ring-1 ring-white/10"
      style={{ background: 'radial-gradient(120% 120% at 50% 0%, #131c2e 0%, #0a0f1a 70%)' }}
    >
      <svg
        viewBox={viewBox}
        className="w-full h-auto block"
        style={{ maxHeight: '32vh' }}
        role="group"
        aria-label={`States in the ${label} region — pick one`}
      >
        {members.map((f) => {
          const isActive = selectedState === f.code;
          const isHot = hovered === f.code;
          return (
            <g
              key={f.code}
              role="button"
              tabIndex={0}
              aria-label={f.name}
              aria-pressed={isActive}
              onClick={() => onPick(f.code)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick(f.code);
                }
              }}
              onMouseEnter={() => setHovered(f.code)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(f.code)}
              onBlur={() => setHovered(null)}
              className="cursor-pointer outline-none"
            >
              <title>{f.name}</title>
              <path
                d={f.d}
                fill={accent}
                fillOpacity={isActive ? 1 : isHot ? 0.85 : 0.5}
                stroke={isActive || isHot ? '#e8eefc' : '#0a0f1a'}
                strokeWidth={(isActive || isHot ? 0.12 : 0.06) * labelSize}
                strokeLinejoin="round"
              />
              <text
                x={f.centroid.x}
                y={f.centroid.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={labelSize}
                fontWeight={700}
                fill="#f8fafc"
                stroke="#0a0f1a"
                strokeWidth={labelSize * 0.14}
                paintOrder="stroke"
                className="pointer-events-none select-none font-mono"
              >
                {f.code}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Geographically-arranged fallback when the GeoJSON can't load (offline,
// blocked, or pre-fetch). Still a full, accessible region picker.
function RegionTiles({ hovered, activeRegion, onHover, onPickRegion }: MapInnerProps) {
  const area: Record<RegionId, string> = {
    west: 'west',
    mountain: 'mtn',
    plains: 'plains',
    midwest: 'glakes',
    south: 'south',
    midatlantic: 'matl',
    newengland: 'nweng',
  };
  return (
    <div
      className="grid gap-1"
      style={{
        gridTemplateAreas: `"west plains glakes nweng" "mtn plains glakes matl" "mtn south south matl"`,
        gridTemplateColumns: 'repeat(4, 1fr)',
      }}
    >
      {REGIONS.map((region) => {
        const isActive = activeRegion === region.id;
        const dimmed = hovered !== null && hovered !== region.id;
        return (
          <button
            key={region.id}
            type="button"
            aria-label={`${region.label} region`}
            aria-pressed={isActive}
            onClick={() => onPickRegion(region.id)}
            onMouseEnter={() => onHover(region.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(region.id)}
            onBlur={() => onHover(null)}
            className={`min-h-[2.4rem] rounded px-1 py-1 text-[10px] font-semibold leading-tight text-white/95 transition-all ${
              isActive ? 'ring-2 ring-white/80' : 'ring-1 ring-white/10'
            } ${dimmed ? 'opacity-40' : 'opacity-100'}`}
            style={{ gridArea: area[region.id], backgroundColor: REGION_THEME[region.id] }}
          >
            {region.label}
          </button>
        );
      })}
    </div>
  );
}
