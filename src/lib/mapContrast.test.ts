import { describe, it, expect, vi } from 'vitest';
import { boostBasemapContrast, type ContrastTarget, type StyleLayer } from './mapContrast';

/**
 * Minimal fake Map that records every paint property write and returns preset
 * read values. Enough surface to exercise `boostBasemapContrast` without
 * pulling in maplibre-gl, matching the approach used in stormMotion.test.ts.
 */
function makeFakeMap(layers: StyleLayer[], paintReads: Record<string, unknown> = {}) {
  const setPaint = vi.fn<(layerId: string, prop: string, value: unknown) => void>();
  const getPaint = vi.fn((layerId: string, prop: string) => paintReads[`${layerId}:${prop}`]);
  const target: ContrastTarget = {
    getStyle: () => ({ layers }),
    getPaintProperty: getPaint,
    setPaintProperty: setPaint,
  };
  return { target, setPaint, getPaint };
}

describe('boostBasemapContrast', () => {
  it('is a no-op when the style has no layers', () => {
    const { target, setPaint } = makeFakeMap([]);
    boostBasemapContrast(target);
    expect(setPaint).not.toHaveBeenCalled();
  });

  it('is a no-op when getStyle() returns undefined', () => {
    const setPaint = vi.fn();
    const target: ContrastTarget = {
      getStyle: () => undefined,
      getPaintProperty: vi.fn(),
      setPaintProperty: setPaint,
    };
    boostBasemapContrast(target);
    expect(setPaint).not.toHaveBeenCalled();
  });

  it('boosts opacity and width on road line layers', () => {
    const layers: StyleLayer[] = [
      { id: 'road-primary', type: 'line', 'source-layer': 'transportation' },
    ];
    const { target, setPaint } = makeFakeMap(layers, {
      'road-primary:line-width': 2,
    });

    boostBasemapContrast(target);

    expect(setPaint).toHaveBeenCalledWith('road-primary', 'line-opacity', 1);
    expect(setPaint).toHaveBeenCalledWith('road-primary', 'line-width', ['*', 2, 2.2]);
  });

  it('wraps expression-valued line-width without unpacking it', () => {
    const expr = ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 6] as const;
    const layers: StyleLayer[] = [{ id: 'road-expr', type: 'line', 'source-layer': 'road' }];
    const { target, setPaint } = makeFakeMap(layers, {
      'road-expr:line-width': expr,
    });

    boostBasemapContrast(target);

    expect(setPaint).toHaveBeenCalledWith('road-expr', 'line-width', ['*', expr, 2.2]);
  });

  it('skips the width boost when line-width is a legacy stops-function object', () => {
    // CartoDB's bridge_trunk_fill / bridge_mot_fill layers ship line-width as
    // `{ base, stops: [...] }`. Embedding that bare object inside an `['*', ...]`
    // expression fails MapLibre validation with "Bare objects invalid". The
    // boost should skip these layers rather than corrupt their paint value.
    const stopsObject = {
      base: 1.2,
      stops: [
        [6, 0.5],
        [20, 30],
      ],
    };
    const layers: StyleLayer[] = [
      { id: 'bridge_trunk_fill', type: 'line', 'source-layer': 'bridge' },
    ];
    const { target, setPaint } = makeFakeMap(layers, {
      'bridge_trunk_fill:line-width': stopsObject,
    });

    boostBasemapContrast(target);

    expect(setPaint).toHaveBeenCalledWith('bridge_trunk_fill', 'line-opacity', 1);
    const widthCalls = setPaint.mock.calls.filter((c) => c[1] === 'line-width');
    expect(widthCalls).toHaveLength(0);
  });

  it('leaves line-width alone when the current value is missing', () => {
    const layers: StyleLayer[] = [
      { id: 'bridge-no-width', type: 'line', 'source-layer': 'bridge' },
    ];
    const { target, setPaint } = makeFakeMap(layers);

    boostBasemapContrast(target);

    // Opacity still gets set, but width is skipped entirely.
    expect(setPaint).toHaveBeenCalledWith('bridge-no-width', 'line-opacity', 1);
    const widthCalls = setPaint.mock.calls.filter((c) => c[1] === 'line-width');
    expect(widthCalls).toHaveLength(0);
  });

  it('adds dark halos to place-label symbol layers without touching text-opacity', () => {
    const layers: StyleLayer[] = [{ id: 'city-names', type: 'symbol', 'source-layer': 'place' }];
    const { target, setPaint } = makeFakeMap(layers);

    boostBasemapContrast(target);

    expect(setPaint).toHaveBeenCalledWith('city-names', 'text-halo-color', '#000000');
    expect(setPaint).toHaveBeenCalledWith('city-names', 'text-halo-width', 4);
    expect(setPaint).toHaveBeenCalledWith('city-names', 'text-halo-blur', 0.5);
    // text-opacity is deliberately left alone so the basemap's zoom-fade
    // expression for low-priority labels keeps working.
    const opacityCalls = setPaint.mock.calls.filter((c) => c[1] === 'text-opacity');
    expect(opacityCalls).toHaveLength(0);
  });

  it('boosts each known label source-layer', () => {
    const layers: StyleLayer[] = [
      { id: 'road-lbl', type: 'symbol', 'source-layer': 'transportation_name' },
      { id: 'water-lbl', type: 'symbol', 'source-layer': 'water_name' },
    ];
    const { target, setPaint } = makeFakeMap(layers);

    boostBasemapContrast(target);

    for (const id of ['road-lbl', 'water-lbl']) {
      expect(setPaint).toHaveBeenCalledWith(id, 'text-halo-width', 4);
    }
  });

  it('does NOT boost poi labels (keeps restaurants/parks from being lifted)', () => {
    const layers: StyleLayer[] = [{ id: 'poi-lbl', type: 'symbol', 'source-layer': 'poi' }];
    const { target, setPaint } = makeFakeMap(layers);

    boostBasemapContrast(target);

    expect(setPaint).not.toHaveBeenCalled();
  });

  it('ignores layers with no source-layer (background, raster, etc.)', () => {
    const layers: StyleLayer[] = [
      { id: 'bg', type: 'background' },
      { id: 'raster-tiles', type: 'raster' },
    ];
    const { target, setPaint } = makeFakeMap(layers);

    boostBasemapContrast(target);

    expect(setPaint).not.toHaveBeenCalled();
  });

  it('ignores line layers on non-road source layers', () => {
    const layers: StyleLayer[] = [
      { id: 'admin-boundary', type: 'line', 'source-layer': 'boundary' },
    ];
    const { target, setPaint } = makeFakeMap(layers, {
      'admin-boundary:line-width': 1,
    });

    boostBasemapContrast(target);

    expect(setPaint).not.toHaveBeenCalled();
  });

  it('ignores symbol layers on non-label source layers', () => {
    const layers: StyleLayer[] = [
      { id: 'shield-housenumber', type: 'symbol', 'source-layer': 'housenumber' },
    ];
    const { target, setPaint } = makeFakeMap(layers);

    boostBasemapContrast(target);

    expect(setPaint).not.toHaveBeenCalled();
  });

  it('keeps boosting remaining layers when one layer throws', () => {
    const layers: StyleLayer[] = [
      { id: 'broken-road', type: 'line', 'source-layer': 'transportation' },
      { id: 'good-road', type: 'line', 'source-layer': 'transportation' },
    ];
    const setPaint = vi.fn<(layerId: string, prop: string, value: unknown) => void>((layerId) => {
      if (layerId === 'broken-road') throw new Error('simulated paint failure');
    });
    const target: ContrastTarget = {
      getStyle: () => ({ layers }),
      getPaintProperty: () => 1,
      setPaintProperty: setPaint,
    };

    boostBasemapContrast(target);

    // Good road still got its paint tweaks despite the broken layer throwing.
    expect(setPaint).toHaveBeenCalledWith('good-road', 'line-opacity', 1);
    expect(setPaint).toHaveBeenCalledWith('good-road', 'line-width', ['*', 1, 2.2]);
  });
});
