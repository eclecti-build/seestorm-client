import { describe, it, expect } from 'vitest';
import {
  asTornadoDetection,
  tornadoTier,
  tornadoEventLabel,
  tornadoMapAnnotation,
  type TornadoDetection,
} from './tornado';

const radar: TornadoDetection = {
  detection: 'RADAR_INDICATED',
  confirmed: false,
  damage_threat: 'BASE',
  source_text: 'Radar indicated rotation',
};
const observed: TornadoDetection = {
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
  it('returns null for non-objects / missing detection / wrong shape', () => {
    expect(asTornadoDetection(null)).toBeNull();
    expect(asTornadoDetection(undefined)).toBeNull();
    expect(asTornadoDetection('OBSERVED')).toBeNull();
    expect(asTornadoDetection({})).toBeNull();
    expect(asTornadoDetection({ detection: 'POSSIBLE' })).toBeNull();
  });

  it('narrows a valid object and derives confirmed from detection', () => {
    expect(asTornadoDetection({ detection: 'OBSERVED' })).toEqual({
      detection: 'OBSERVED',
      confirmed: true,
      damage_threat: 'BASE',
      source_text: undefined,
    });
    expect(asTornadoDetection({ detection: 'RADAR_INDICATED' })?.confirmed).toBe(false);
  });

  it('keeps only recognized damage threats, others degrade to BASE', () => {
    expect(
      asTornadoDetection({ detection: 'OBSERVED', damage_threat: 'CONSIDERABLE' })?.damage_threat,
    ).toBe('CONSIDERABLE');
    expect(
      asTornadoDetection({ detection: 'OBSERVED', damage_threat: 'DESTRUCTIVE' })?.damage_threat,
    ).toBe('BASE');
  });
});

describe('tornadoTier', () => {
  it('detection certainty leads — unconfirmed is RADAR regardless of damage threat', () => {
    expect(tornadoTier(radar)).toBe('RADAR');
    expect(
      tornadoTier({
        detection: 'RADAR_INDICATED',
        confirmed: false,
        damage_threat: 'CATASTROPHIC',
      }),
    ).toBe('RADAR');
  });
  it('confirmed tiers escalate by damage threat', () => {
    expect(tornadoTier(observed)).toBe('OBSERVED');
    expect(tornadoTier(pds)).toBe('PDS');
    expect(tornadoTier(emergency)).toBe('EMERGENCY');
  });
});

describe('tornadoEventLabel', () => {
  it('falls back to the bare event when there is no detection', () => {
    expect(tornadoEventLabel('Tornado Warning', null)).toBe('Tornado Warning');
  });
  it('appends the safe certainty suffix and folds in damage-threat naming', () => {
    expect(tornadoEventLabel('Tornado Warning', radar)).toBe('Tornado Warning (Radar Indicated)');
    expect(tornadoEventLabel('Tornado Warning', observed)).toBe('Tornado Warning (Observed)');
    expect(tornadoEventLabel('Tornado Warning', pds)).toBe('Tornado Warning · PDS (Observed)');
    expect(tornadoEventLabel('Tornado Warning', emergency)).toBe('Tornado Emergency (Observed)');
  });
});

describe('tornadoMapAnnotation', () => {
  it('is empty unless the tornado is confirmed (radar-indicated gets no on-map CTA)', () => {
    expect(tornadoMapAnnotation(null)).toBe('');
    expect(tornadoMapAnnotation(radar)).toBe('');
  });
  it('escalates the on-map call-to-action by damage threat', () => {
    expect(tornadoMapAnnotation(observed)).toBe('OBSERVED TORNADO — TAKE COVER');
    expect(tornadoMapAnnotation(pds)).toBe('CONFIRMED TORNADO (PDS) — TAKE COVER');
    expect(tornadoMapAnnotation(emergency)).toBe('TORNADO EMERGENCY — TAKE COVER NOW');
  });
});
