'use client';

/**
 * Web Worker offload for the alerts parse + view-build pipeline (Tier 3
 * #5a). The nationwide live feed's resp.json() -> parseIngestSnapshot ->
 * buildAlertViews (Turf point-in-polygon over ~650 county features per
 * zone-only alert, GeoJSON diffing) previously ran synchronously on the
 * main thread BEFORE the startTransition wrap in WeatherMap.tsx's
 * fetchLive/fetchHistorical — the swarm audit's 2,104ms INP measurement
 * covered the state-apply side inside startTransition, but the parse+build
 * side that runs before it was never itself moved off the main thread.
 * This client moves that work into a dedicated Worker.
 *
 * Structured-clone constraint: CountyLookup (src/lib/countyGeometry.ts) is
 * a CLOSURE over a Map — not structured-cloneable. The worker receives the
 * raw county FeatureCollection instead and rebuilds its own lookup inside
 * the worker via buildCountyLookup. See alerts.worker.ts.
 *
 * Falls back to synchronous main-thread parsing if `new Worker(...)`
 * construction throws (older browser, CSP worker-src gap, or — defensively
 * — a bundler/runtime combination that doesn't support the
 * `new Worker(new URL(...), import.meta.url)` pattern under static export),
 * or after a worker runtime error. For the post-crash case, this client
 * retains a reference to the most recent non-null county FeatureCollection
 * WeatherMap passed in. That is deliberately a reference, not a copy:
 * WeatherMap already owns the same object via countyFeaturesRef, so the
 * retained pointer gives fallback parsing enough data to rebuild
 * syncCountyLookup without duplicating a multi-MB county payload in memory.
 */

import type { IngestSnapshot, AlertsResponse, WeatherAlert, IngestAlert } from './alerts';
import { parseIngestSnapshot, buildAlertViews } from './alerts';
import { buildCountyLookup, type CountyLookup } from './countyGeometry';

export interface ParseAndBuildOptions {
  userState?: string;
  userPoint?: { lat: number; lon: number; state: string };
  allowedStates?: readonly string[];
  nowMs?: number;
  useSnapshotTimeAsNow?: boolean;
}

export interface ParseAndBuildResult {
  snapshot: IngestSnapshot;
  mapFeatures: AlertsResponse;
  listAlerts: WeatherAlert[];
  motionAlerts: IngestAlert[];
}

type WorkerRequest =
  | ({
      type: 'parse';
      requestId: number;
      raw: unknown;
      countyState: string | null;
    } & ParseAndBuildOptions)
  | {
      type: 'counties';
      stateCode: string | null;
      countiesGeoJSON: GeoJSON.FeatureCollection | null;
    };

type WorkerResponse =
  | ({ type: 'parsed'; requestId: number } & ParseAndBuildResult)
  | { type: 'error'; requestId: number; message: string };

function parseAndBuildSync(
  raw: unknown,
  options: ParseAndBuildOptions,
  countyLookup: CountyLookup | null,
): ParseAndBuildResult {
  const snapshot = parseIngestSnapshot(raw);
  const { useSnapshotTimeAsNow, ...viewOptions } = options;
  const nowMs =
    useSnapshotTimeAsNow && snapshot.generated_at_ms && Number.isFinite(snapshot.generated_at_ms)
      ? snapshot.generated_at_ms
      : useSnapshotTimeAsNow
        ? Date.parse(snapshot.generated_at)
        : viewOptions.nowMs;
  const { mapFeatures, listAlerts, motionAlerts } = buildAlertViews(snapshot, {
    ...viewOptions,
    countyLookup: countyLookup ?? undefined,
    nowMs,
  });
  return { snapshot, mapFeatures, listAlerts, motionAlerts };
}

export class AlertsWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private pending = new Map<
    number,
    { resolve: (r: ParseAndBuildResult) => void; reject: (e: Error) => void }
  >();
  // Fallback-mode county lookup — built LAZILY inside sendCounties(), only
  // when the worker isn't active (see sendCounties below). In fallback
  // mode this IS the only lookup path, so building it is never wasted
  // work; when the worker is active it would otherwise be dead CPU spent
  // on every state switch for a value nothing reads.
  private syncCountyLookup: CountyLookup | null = null;
  // Tracks every county state already sent to the worker, so a user
  // revisiting a previously-selected state (e.g. WI -> IL -> WI) doesn't
  // pay for a redundant structured-clone of a multi-MB FeatureCollection
  // across the worker boundary — the worker already retains that state's
  // lookup from earlier in the session (see alerts.worker.ts's
  // countyLookupsByState Map).
  private sentCountyStates = new Set<string>();
  private activeCountyState: string | null = null;
  // Most recent non-null county payload passed by WeatherMap. This is a
  // reference only (no clone), so a worker crash can rebuild the fallback
  // lookup without waiting for another state switch or duplicating the
  // county FeatureCollection WeatherMap already retains.
  private lastCountiesStateCode: string | null = null;
  private lastCountiesGeoJSON: GeoJSON.FeatureCollection | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL('./alerts.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.addEventListener('message', this.handleMessage);
      this.worker.addEventListener('error', this.handleWorkerError);
    } catch (err) {
      console.error(
        'AlertsWorkerClient: Worker construction failed, falling back to main-thread parse',
        err,
      );
      this.worker = null;
    }
  }

  get isWorkerActive(): boolean {
    return this.worker !== null;
  }

  private handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const data = event.data;
    const entry = this.pending.get(data.requestId);
    if (!entry) return; // stale/unknown requestId — ignore
    this.pending.delete(data.requestId);
    if (data.type === 'error') {
      entry.reject(new Error(data.message));
      return;
    }
    entry.resolve({
      snapshot: data.snapshot,
      mapFeatures: data.mapFeatures,
      listAlerts: data.listAlerts,
      motionAlerts: data.motionAlerts,
    });
  };

  // A worker-level runtime failure (e.g. the module itself throws on
  // load) rejects every in-flight request instead of hanging them
  // forever, then tears down worker mode so subsequent calls fall back to
  // the sync path.
  private handleWorkerError = (event: ErrorEvent): void => {
    console.error(
      'AlertsWorkerClient: worker runtime error, falling back to main-thread parse',
      event.message,
    );
    const err = new Error(`alerts worker error: ${event.message}`);
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    try {
      this.syncCountyLookup =
        this.lastCountiesStateCode && this.lastCountiesGeoJSON
          ? buildCountyLookup(this.lastCountiesGeoJSON)
          : null;
    } catch (err) {
      console.error(
        'AlertsWorkerClient: failed to rebuild fallback county lookup after worker error',
        err,
      );
      this.syncCountyLookup = null;
    }
  };

  sendCounties(stateCode: string | null, countiesGeoJSON: GeoJSON.FeatureCollection | null): void {
    this.activeCountyState = stateCode;
    if (stateCode !== null && countiesGeoJSON !== null) {
      this.lastCountiesStateCode = stateCode;
      this.lastCountiesGeoJSON = countiesGeoJSON;
    }
    if (!this.worker) {
      // Fallback mode: this build IS the only lookup path (parseAndBuild's
      // sync branch below reads syncCountyLookup directly), so it's never
      // dead weight here — build it eagerly, right where it's needed.
      this.syncCountyLookup = countiesGeoJSON ? buildCountyLookup(countiesGeoJSON) : null;
      return;
    }
    if (stateCode !== null && this.sentCountyStates.has(stateCode)) {
      // Worker already holds this exact state's lookup from earlier in the
      // session (see alerts.worker.ts) — skip the redundant clone+postMessage.
      return;
    }
    if (stateCode !== null) this.sentCountyStates.add(stateCode);
    const msg: WorkerRequest = { type: 'counties', stateCode, countiesGeoJSON };
    this.worker.postMessage(msg);
  }

  async parseAndBuild(raw: unknown, options: ParseAndBuildOptions): Promise<ParseAndBuildResult> {
    if (!this.worker) {
      return parseAndBuildSync(raw, options, this.syncCountyLookup);
    }
    const requestId = this.nextRequestId++;
    const msg: WorkerRequest = {
      type: 'parse',
      requestId,
      raw,
      countyState: this.activeCountyState,
      ...options,
    };
    return new Promise<ParseAndBuildResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker!.postMessage(msg);
    });
  }

  dispose(): void {
    const err = new Error('alerts worker disposed');
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
