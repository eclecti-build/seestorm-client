import { describe, expect, it } from 'vitest';
import { buildEventColorExpression, buildTornadoColorExpression } from './alertPaint';

// This is the EXACT expression WeatherMap.tsx hardcoded before this change.
// Locking it guarantees default mode does not alter the map. Note: Freeze and
// Special Weather Statement are intentionally absent (they fall through to the
// gray fallback on the map today) — do not "fix" that here.
const LEGACY_EVENT_COLOR = [
  'match',
  ['get', 'event'],
  'Tornado Warning',
  '#FF0000',
  'Tornado Watch',
  '#FFFF00',
  'Severe Thunderstorm Warning',
  '#FFA500',
  'Severe Thunderstorm Watch',
  '#DB7093',
  'Flash Flood Warning',
  '#8B0000',
  'Flash Flood Watch',
  '#2E8B57',
  'Flood Warning',
  '#B22222',
  'Flood Watch',
  '#3CB371',
  'Flood Advisory',
  '#6CA6CD',
  'Flood Statement',
  '#6CA6CD',
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
  it('cbFriendly mode also colors Freeze and Special Weather Statement (gray on the map in default mode)', () => {
    const expr = buildEventColorExpression('cbFriendly');
    expect(expr).toContain('Freeze Warning');
    expect(expr).toContain('#CC79A7');
    expect(expr).toContain('Special Weather Statement');
    expect(expr).toContain('#009E73');
  });
  it('default mode does NOT add the CB-only events (look unchanged)', () => {
    const expr = buildEventColorExpression('default');
    expect(expr).not.toContain('Freeze Warning');
    expect(expr).not.toContain('Special Weather Statement');
  });
});

describe('buildTornadoColorExpression', () => {
  it('default mode resolves categories to the current ramp', () => {
    expect(buildTornadoColorExpression('default')).toEqual([
      'match',
      ['get', 'tornadoCategory'],
      'RADAR_INDICATED',
      '#FF8C42',
      'CONFIRMED',
      '#FF1A1A',
      'PDS',
      '#B5002E',
      'EMERGENCY',
      '#C026D3',
      '#FF8C42',
    ]);
  });
  it('cbFriendly mode resolves categories to the CB ramp', () => {
    expect(buildTornadoColorExpression('cbFriendly')).toEqual([
      'match',
      ['get', 'tornadoCategory'],
      'RADAR_INDICATED',
      '#B05CA8',
      'CONFIRMED',
      '#D44FA0',
      'PDS',
      '#F06595',
      'EMERGENCY',
      '#FF9EC4',
      '#B05CA8',
    ]);
  });
});
