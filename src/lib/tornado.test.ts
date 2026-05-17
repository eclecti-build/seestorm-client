import { describe, it, expect } from 'vitest';
import {
  asTornadoDetection,
  tornadoCategory,
  tornadoColor,
  tornadoLabel,
  tornadoLabelTitle,
  tornadoMapAnnotation,
  type TornadoDetection,
} from './tornado';

const radar: TornadoDetection = {
  detection: 'RADAR_INDICATED',
  confirmed: false,
  damage_threat: 'BASE',
  source_text: 'Radar indicated rotation',
};
const confirmed: TornadoDetection = {
  detection: 'OBSERVED',
  confirmed: true,
  damage_threat: 'BASE',
};
const pds: TornadoDetection = {
  detection: 'OBSERVED',
  confirmed: true,
  damage_threat: 'CONSIDERABLE',
};
const emergency: TornadoDetection = {
  detection: 'OBSERVED',
  confirmed: true,
  damage_threat: 'CATASTROPHIC',
};

describe('asTornadoDetection', () => {
  it('rejects non-objects / missing / wrong shape', () => {
    expect(asTornadoDetection(null)).toBeNull();
    expect(asTornadoDetection('OBSERVED')).toBeNull();
    expect(asTornadoDetection({})).toBeNull();
    expect(asTornadoDetection({ detection: 'POSSIBLE' })).toBeNull();
  });
  it('narrows and derives confirmed; unknown damage threat degrades to BASE', () => {
    expect(asTornadoDetection({ detection: 'OBSERVED' })).toEqual({
      detection: 'OBSERVED',
      confirmed: true,
      damage_threat: 'BASE',
      source_text: undefined,
    });
    expect(asTornadoDetection({ detection: 'RADAR_INDICATED' })?.confirmed).toBe(false);
    expect(
      asTornadoDetection({ detection: 'OBSERVED', damage_threat: 'DESTRUCTIVE' })?.damage_threat,
    ).toBe('BASE');
  });
});

describe('tornadoCategory — the normalized ladder', () => {
  it('detection certainty leads: unconfirmed is RADAR_INDICATED regardless of damage threat', () => {
    expect(tornadoCategory(radar)).toBe('RADAR_INDICATED');
    expect(
      tornadoCategory({
        detection: 'RADAR_INDICATED',
        confirmed: false,
        damage_threat: 'CATASTROPHIC',
      }),
    ).toBe('RADAR_INDICATED');
  });
  it('confirmed escalates by damage threat', () => {
    expect(tornadoCategory(confirmed)).toBe('CONFIRMED');
    expect(tornadoCategory(pds)).toBe('PDS');
    expect(tornadoCategory(emergency)).toBe('EMERGENCY');
  });
});

describe('tornadoColor — magenta ramp', () => {
  it('maps each category to its locked hex', () => {
    expect(tornadoColor(radar)).toBe('#FF8C42');
    expect(tornadoColor(confirmed)).toBe('#FF1A1A');
    expect(tornadoColor(pds)).toBe('#B5002E');
    expect(tornadoColor(emergency)).toBe('#C026D3');
  });
});

describe('tornadoLabel — single normalized label, never a compound', () => {
  it('falls back to the bare event when no detection', () => {
    expect(tornadoLabel('Tornado Warning', null)).toBe('Tornado Warning');
  });
  it('uses "Confirmed" (never "Observed") and the real NWS product names', () => {
    expect(tornadoLabel('Tornado Warning', radar)).toBe('Tornado Warning — Radar Indicated');
    expect(tornadoLabel('Tornado Warning', confirmed)).toBe('Tornado Warning — Confirmed');
    expect(tornadoLabel('Tornado Warning', pds)).toBe('PDS Tornado Warning');
    expect(tornadoLabel('Tornado Warning', emergency)).toBe('Tornado Emergency');
  });
  it('never emits a compound like "PDS (Observed)"', () => {
    for (const d of [radar, confirmed, pds, emergency]) {
      const label = tornadoLabel('Tornado Warning', d);
      expect(label).not.toMatch(/observed/i);
      expect(label).not.toMatch(/\(.*\)/);
    }
  });
});

describe('tornadoLabelTitle — spelled-out tooltip', () => {
  it('is undefined without a detection; spells out PDS', () => {
    expect(tornadoLabelTitle(null)).toBeUndefined();
    expect(tornadoLabelTitle(pds)).toMatch(/Particularly Dangerous Situation/);
    expect(tornadoLabelTitle(radar)).toMatch(/not yet confirmed/i);
  });
});

describe('tornadoMapAnnotation — consistent CTA verb', () => {
  it('is empty for not-confirmed (radar-indicated gets no on-map CTA)', () => {
    expect(tornadoMapAnnotation(null)).toBe('');
    expect(tornadoMapAnnotation(radar)).toBe('');
  });
  it('escalates with one consistent verb (TAKE COVER), no observed/confirmed drift', () => {
    expect(tornadoMapAnnotation(confirmed)).toBe('CONFIRMED TORNADO — TAKE COVER');
    expect(tornadoMapAnnotation(pds)).toBe('PDS — TAKE COVER NOW');
    expect(tornadoMapAnnotation(emergency)).toBe('TORNADO EMERGENCY — TAKE COVER NOW');
  });
});
