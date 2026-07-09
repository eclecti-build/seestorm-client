/**
 * Web Worker: alerts parse + view-build pipeline. See useAlertsWorker.ts
 * for the main-thread client and the structured-clone rationale for why
 * this worker rebuilds its own CountyLookup from a raw FeatureCollection
 * rather than receiving the lookup function directly.
 *
 * This is a browser Web Worker (runs in the user's tab) — unrelated to the
 * Cloudflare edge Worker at worker/index.ts (different runtime: that one
 * proxies R2 reads at the edge; this one offloads CPU work in the client).
 */
/// <reference lib="webworker" />

import { parseIngestSnapshot, buildAlertViews } from './alerts';
import { buildCountyLookup, type CountyLookup } from './countyGeometry';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Retains one CountyLookup PER STATE the user has visited this session,
// not just the current one — the client (useAlertsWorker.ts) tracks which
// states it has already sent and skips re-sending a state it already sent
// once (see AlertsWorkerClient.sendCounties), so this worker must be able
// to serve a lookup for a state it isn't being told about again. Bounded
// in practice: at most 50 US states/territories ever accumulate here in a
// single tab's lifetime, which is a trivial memory footprint.
const countyLookupsByState = new Map<string, CountyLookup>();

interface ParseRequest {
  type: 'parse';
  requestId: number;
  raw: unknown;
  countyState: string | null;
  userState?: string;
  userPoint?: { lat: number; lon: number; state: string };
  allowedStates?: readonly string[];
  nowMs?: number;
  useSnapshotTimeAsNow?: boolean;
}

interface CountiesRequest {
  type: 'counties';
  stateCode: string | null;
  countiesGeoJSON: GeoJSON.FeatureCollection | null;
}

type WorkerRequest = ParseRequest | CountiesRequest;

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'counties') {
    try {
      if (msg.stateCode && msg.countiesGeoJSON && !countyLookupsByState.has(msg.stateCode)) {
        countyLookupsByState.set(msg.stateCode, buildCountyLookup(msg.countiesGeoJSON));
      }
    } catch (err) {
      console.error('[alerts.worker] failed to hydrate county lookup', err);
    }
    return;
  }

  const countyLookup = msg.countyState ? (countyLookupsByState.get(msg.countyState) ?? null) : null;

  try {
    const snapshot = parseIngestSnapshot(msg.raw);
    const nowMs =
      msg.useSnapshotTimeAsNow &&
      snapshot.generated_at_ms &&
      Number.isFinite(snapshot.generated_at_ms)
        ? snapshot.generated_at_ms
        : msg.useSnapshotTimeAsNow
          ? Date.parse(snapshot.generated_at)
          : msg.nowMs;
    const { mapFeatures, listAlerts, motionAlerts } = buildAlertViews(snapshot, {
      countyLookup: countyLookup ?? undefined,
      userState: msg.userState,
      userPoint: msg.userPoint,
      allowedStates: msg.allowedStates,
      nowMs,
    });
    ctx.postMessage({
      type: 'parsed',
      requestId: msg.requestId,
      snapshot,
      mapFeatures,
      listAlerts,
      motionAlerts,
    });
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
