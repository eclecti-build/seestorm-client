// Tornado detection — client display contract.
//
// Mirrors the normalized `tornado` object seestorm-ingest derives onto each
// alert (see umbrella docs/TORNADO_DETECTION_CONTRACT.md). The whole point
// is to make the "is it confirmed on the ground, or just radar-indicated?"
// distinction legible WITHOUT semantic drift:
//
//   - RADAR_INDICATED → "(Radar Indicated)" — never "on the ground".
//   - OBSERVED        → "(Observed)" — confirmed. NOT "a spotter saw it"
//                       unless source_text actually attributes a human.
//
// These helpers are pure so they unit-test without a map and so the same
// label appears identically in the popup, the side panel, and the on-map
// annotation (drift comes from divergent strings).

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
 * A single coarse tier for styling/legend. Detection certainty leads:
 * an un-confirmed alert is RADAR regardless of damage threat (the contract
 * forbids inferring confirmation from damage threat).
 */
export type TornadoTier = 'RADAR' | 'OBSERVED' | 'PDS' | 'EMERGENCY';

/** Narrow an unknown value (e.g. a loosely-cast snapshot field) to TornadoDetection. */
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

export function tornadoTier(d: TornadoDetection): TornadoTier {
  if (!d.confirmed) return 'RADAR';
  if (d.damage_threat === 'CATASTROPHIC') return 'EMERGENCY';
  if (d.damage_threat === 'CONSIDERABLE') return 'PDS';
  return 'OBSERVED';
}

/**
 * The product name with damage-threat escalation folded in. "Tornado
 * Emergency" is its own NWS name (not "Tornado Warning (catastrophic)");
 * CONSIDERABLE is the colloquial "PDS".
 */
function tornadoProductName(baseEvent: string, d: TornadoDetection): string {
  if (d.damage_threat === 'CATASTROPHIC') return 'Tornado Emergency';
  if (d.damage_threat === 'CONSIDERABLE') return `${baseEvent} · PDS`;
  return baseEvent;
}

/**
 * The full label shown to users, e.g. "Tornado Warning (Observed)" /
 * "Tornado Warning (Radar Indicated)" / "Tornado Emergency (Observed)".
 *
 * Anti-drift: a confirmed tornado that NWS only confirmed via radar debris
 * signature is still "(Observed)" — we never claim a human saw it unless
 * `source_text` explicitly attributes one. So the suffix stays the safe,
 * NWS-aligned word and source attribution is left to the detail text.
 */
export function tornadoEventLabel(baseEvent: string, d: TornadoDetection | null): string {
  if (!d) return baseEvent;
  const name = tornadoProductName(baseEvent, d);
  return d.confirmed ? `${name} (Observed)` : `${name} (Radar Indicated)`;
}

/**
 * The terse on-map call-to-action, only for CONFIRMED tornadoes (the
 * "it has touched down" case). Returns '' when not confirmed so the
 * annotation layer naturally renders nothing for radar-indicated.
 */
export function tornadoMapAnnotation(d: TornadoDetection | null): string {
  if (!d || !d.confirmed) return '';
  if (d.damage_threat === 'CATASTROPHIC') return 'TORNADO EMERGENCY — TAKE COVER NOW';
  if (d.damage_threat === 'CONSIDERABLE') return 'CONFIRMED TORNADO (PDS) — TAKE COVER';
  return 'OBSERVED TORNADO — TAKE COVER';
}
