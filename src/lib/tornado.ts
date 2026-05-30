// Tornado detection — client display contract.
//
// NWS encodes two independent facts about a tornado warning:
//   - detection:     RADAR_INDICATED (not confirmed) vs OBSERVED (confirmed)
//   - damage_threat:  BASE | CONSIDERABLE (PDS) | CATASTROPHIC (Emergency)
//
// Showing both axes as a compound string ("PDS (Observed)") is confusing
// and redundant — a PDS is *always* a confirmed tornado. NWS, mets, and
// public messaging instead use a SINGLE escalating ladder, because
// CONSIDERABLE/CATASTROPHIC are only issued for a confirmed tornado. So we
// normalize the two axes into ONE ordered category and present that — never
// a cross-product.
//
//   Radar Indicated  →  Confirmed  →  PDS  →  Tornado Emergency
//
// Vocabulary is locked (see umbrella docs/TORNADO_DETECTION_CONTRACT.md):
//   - "Confirmed" is the public word for the OBSERVED state. "Observed" is
//     NWS tag jargon and never appears in the UI. (NWS's own escalation
//     language: "...refer to it as a confirmed tornado".)
//   - PDS / Tornado Emergency keep their real NWS names; PDS carries a
//     spelled-out tooltip.
//   - One label, one color, one call-to-action per level. No compounds.

export type TornadoDetectionState = 'RADAR_INDICATED' | 'OBSERVED';
export type TornadoDamageThreat = 'BASE' | 'CONSIDERABLE' | 'CATASTROPHIC';

/** Shape of the additive `tornado` object on an ingest alert. */
export interface TornadoDetection {
  detection: TornadoDetectionState;
  confirmed: boolean;
  damage_threat: TornadoDamageThreat;
  source_text?: string;
}

/**
 * The normalized, ordered category actually shown to users. Detection
 * certainty leads: an unconfirmed alert is RADAR_INDICATED regardless of
 * damage threat (the contract forbids inferring confirmation from damage
 * threat — under-claiming is the safe direction).
 */
export type TornadoCategory = 'RADAR_INDICATED' | 'CONFIRMED' | 'PDS' | 'EMERGENCY';

/** Narrow an unknown value (loosely-cast snapshot field) to TornadoDetection. */
export function asTornadoDetection(v: unknown): TornadoDetection | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.detection !== 'RADAR_INDICATED' && o.detection !== 'OBSERVED') return null;
  const dt =
    o.damage_threat === 'CONSIDERABLE' || o.damage_threat === 'CATASTROPHIC'
      ? o.damage_threat
      : 'BASE';
  return {
    detection: o.detection,
    confirmed: o.detection === 'OBSERVED',
    damage_threat: dt,
    source_text: typeof o.source_text === 'string' ? o.source_text : undefined,
  };
}

export function tornadoCategory(d: TornadoDetection): TornadoCategory {
  if (!d.confirmed) return 'RADAR_INDICATED';
  if (d.damage_threat === 'CATASTROPHIC') return 'EMERGENCY';
  if (d.damage_threat === 'CONSIDERABLE') return 'PDS';
  return 'CONFIRMED';
}

import type { ColorVisionMode } from './colorVisionMode';

// Hue-shift-to-magenta ramp (locked). Differentiation ascends the ladder;
// Tornado Emergency = magenta, matching the RadarScope/NWS convention.
export const TORNADO_CATEGORY_COLOR: Record<TornadoCategory, string> = {
  RADAR_INDICATED: '#FF8C42', // orange-red — "not confirmed yet"
  CONFIRMED: '#FF1A1A', // red — confirmed on the ground
  PDS: '#B5002E', // deep crimson — particularly dangerous
  EMERGENCY: '#C026D3', // magenta — catastrophic, rarest
};

// Colorblind-safe tornado ladder (opt-in). A single magenta family that
// climbs in brightness — on the dark basemap brighter reads as more severe,
// and the magenta region stays distinguishable across CVD types. The existing
// category-scaled halo width + confirmed pulse reinforce the escalation.
export const TORNADO_CATEGORY_COLOR_CB: Record<TornadoCategory, string> = {
  RADAR_INDICATED: '#B05CA8',
  CONFIRMED: '#D44FA0',
  PDS: '#F06595',
  EMERGENCY: '#FF9EC4',
};

export function tornadoCategoryColorsFor(mode: ColorVisionMode): Record<TornadoCategory, string> {
  return mode === 'cbFriendly' ? TORNADO_CATEGORY_COLOR_CB : TORNADO_CATEGORY_COLOR;
}

export function tornadoColor(d: TornadoDetection, mode: ColorVisionMode = 'default'): string {
  return tornadoCategoryColorsFor(mode)[tornadoCategory(d)];
}

/**
 * The single normalized label. NEVER a compound. `baseEvent` is the NWS
 * event_type ("Tornado Warning"); PDS/Emergency override it with their own
 * NWS product names.
 */
export function tornadoLabel(baseEvent: string, d: TornadoDetection | null): string {
  if (!d) return baseEvent;
  switch (tornadoCategory(d)) {
    case 'RADAR_INDICATED':
      return `${baseEvent} — Radar Indicated`;
    case 'CONFIRMED':
      return `${baseEvent} — Confirmed`;
    case 'PDS':
      return 'Particularly Dangerous Tornado Warning';
    case 'EMERGENCY':
      return 'Tornado Emergency';
  }
}

/**
 * Spelled-out expansion for a hover/title tooltip — keeps the jargon
 * ("PDS") legible without bloating the label.
 */
export function tornadoLabelTitle(d: TornadoDetection | null): string | undefined {
  if (!d) return undefined;
  switch (tornadoCategory(d)) {
    case 'RADAR_INDICATED':
      return 'Radar-indicated rotation — tornado not yet confirmed';
    case 'CONFIRMED':
      return 'Confirmed tornado — spotter, law enforcement, or radar debris signature';
    case 'PDS':
      return 'Particularly Dangerous Situation (PDS) — confirmed strong tornado';
    case 'EMERGENCY':
      return 'Tornado Emergency — confirmed violent tornado, catastrophic threat to life';
  }
}

/**
 * The terse on-map call-to-action, only for CONFIRMED-or-worse (the
 * "it has touched down" cases). Returns '' for radar-indicated so the
 * annotation layer renders nothing. Consistent verb ("TAKE COVER")
 * across all levels — no "observed" vs "confirmed" wording drift.
 */
export function tornadoMapAnnotation(d: TornadoDetection | null): string {
  if (!d || !d.confirmed) return '';
  switch (tornadoCategory(d)) {
    case 'EMERGENCY':
      return 'TORNADO EMERGENCY — TAKE COVER NOW';
    case 'PDS':
      return 'PARTICULARLY DANGEROUS — TAKE COVER NOW';
    default:
      return 'CONFIRMED TORNADO — TAKE COVER';
  }
}
