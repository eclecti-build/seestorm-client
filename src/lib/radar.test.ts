import { describe, it, expect } from 'vitest';
import { radarTileUrl } from './radar';

describe('radarTileUrl', () => {
  it('returns the live composite layer URL when passed "live"', () => {
    expect(radarTileUrl('live')).toBe(
      'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
    );
  });

  it('formats a 5-min-aligned UTC timestamp into the archive URL', () => {
    // 2026-04-17 04:45:00 UTC
    const t = new Date(Date.UTC(2026, 3, 17, 4, 45, 0));
    expect(radarTileUrl(t)).toBe(
      'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-202604170445/{z}/{x}/{y}.png',
    );
  });

  it('rounds DOWN to the previous 5-min block', () => {
    // 04:49:06 → 04:45
    const t = new Date(Date.UTC(2026, 3, 17, 4, 49, 6));
    expect(radarTileUrl(t)).toContain('USCOMP-N0Q-202604170445');

    // 04:44:59 → 04:40
    const t2 = new Date(Date.UTC(2026, 3, 17, 4, 44, 59));
    expect(radarTileUrl(t2)).toContain('USCOMP-N0Q-202604170440');

    // 04:50:00 → 04:50 (exact block edge stays)
    const t3 = new Date(Date.UTC(2026, 3, 17, 4, 50, 0));
    expect(radarTileUrl(t3)).toContain('USCOMP-N0Q-202604170450');
  });

  it('pads single-digit month/day/hour/minute correctly', () => {
    // 2026-01-02 03:04:05 UTC → snap to 03:00
    const t = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(radarTileUrl(t)).toContain('USCOMP-N0Q-202601020300');
  });

  it('uses UTC regardless of host timezone', () => {
    // A specific UTC instant always produces the same string.
    const t = new Date('2026-04-17T04:45:00Z');
    expect(radarTileUrl(t)).toContain('USCOMP-N0Q-202604170445');
  });
});
