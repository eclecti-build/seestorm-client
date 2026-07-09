import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseIngestSnapshot, buildAlertViews } from './alerts';
import { AlertsWorkerClient } from './useAlertsWorker';

const RAW_SNAPSHOT = {
  generated_at: '2026-07-08T00:00:00Z',
  generated_at_ms: 1751932800000,
  schema_version: 2,
  areas: ['WI'],
  alert_count: 1,
  alerts: [
    {
      nws_id: 'TEST-1',
      event_type: 'Tornado Warning',
      severity: 'Extreme',
      headline: 'Test warning',
      description: 'Test',
      area_desc: 'Dane, WI',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-89.5, 43.0],
            [-89.4, 43.0],
            [-89.4, 43.1],
            [-89.5, 43.1],
            [-89.5, 43.0],
          ],
        ],
      },
      effective_at: '2026-07-08T00:00:00Z',
      expires_at: '2026-07-08T01:00:00Z',
      area_state: 'WI',
      states: ['WI'],
    },
  ],
};

/**
 * Fake Worker whose postMessage runs the REAL parseIngestSnapshot +
 * buildAlertViews (the same functions the production worker file imports)
 * and echoes a `parsed` response on the next microtask. This validates the
 * real message contract round-trips correctly, not a hand-wavy stub —
 * jsdom does not implement a real Worker, so this is the standard way to
 * unit-test worker-client message-passing logic.
 */
class FakeWorker {
  static shouldThrowOnConstruct = false;
  // Counts 'counties' messages actually posted to the worker — the dedup
  // amendment's whole point is that a repeat state should NOT increment
  // this, so tests assert against it directly rather than inferring from
  // side effects.
  static countiesMessageCount = 0;
  static lastInstance: FakeWorker | null = null;
  private messageHandlers: Array<(e: MessageEvent) => void> = [];
  private errorHandlers: Array<(e: ErrorEvent) => void> = [];

  constructor() {
    if (FakeWorker.shouldThrowOnConstruct) throw new Error('blocked (test)');
    FakeWorker.lastInstance = this;
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void): void {
    if (type === 'message') this.messageHandlers.push(handler);
    if (type === 'error') this.errorHandlers.push(handler as unknown as (e: ErrorEvent) => void);
  }
  removeEventListener(): void {}
  terminate(): void {}

  emitError(message: string): void {
    const event = { message } as ErrorEvent;
    for (const h of this.errorHandlers) h(event);
  }

  postMessage(msg: { type: string; [k: string]: unknown }): void {
    if (msg.type === 'counties') {
      FakeWorker.countiesMessageCount++;
      return; // county hydration ITSELF isn't under test here — only dedup
    }
    queueMicrotask(() => {
      try {
        const snapshot = parseIngestSnapshot(msg.raw);
        const built = buildAlertViews(snapshot, {
          userState: msg.userState as string | undefined,
        });
        const event = {
          data: { type: 'parsed', requestId: msg.requestId, snapshot, ...built },
        } as unknown as MessageEvent;
        for (const h of this.messageHandlers) h(event);
      } catch (err) {
        const event = {
          data: {
            type: 'error',
            requestId: msg.requestId,
            message: err instanceof Error ? err.message : String(err),
          },
        } as unknown as MessageEvent;
        for (const h of this.messageHandlers) h(event);
      }
    });
  }
}

const FAKE_WI_COUNTIES: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

const DANE_COUNTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { NAME: 'Dane', STATE: '55' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-89.6, 42.9],
            [-89.2, 42.9],
            [-89.2, 43.2],
            [-89.6, 43.2],
            [-89.6, 42.9],
          ],
        ],
      },
    },
  ],
};

const RAW_ZONE_ONLY_SNAPSHOT = {
  ...RAW_SNAPSHOT,
  alerts: [
    {
      ...RAW_SNAPSHOT.alerts[0],
      nws_id: 'WATCH-1',
      event_type: 'Tornado Watch',
      geometry: null,
      area_desc: 'Dane, WI',
    },
  ],
};

describe('AlertsWorkerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-08T00:30:00Z'));
    FakeWorker.shouldThrowOnConstruct = false;
    FakeWorker.countiesMessageCount = 0;
    FakeWorker.lastInstance = null;
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('parses via the worker and matches the pure-function baseline', async () => {
    const client = new AlertsWorkerClient();
    expect(client.isWorkerActive).toBe(true);

    const result = await client.parseAndBuild(RAW_SNAPSHOT, {});
    const expected = buildAlertViews(parseIngestSnapshot(RAW_SNAPSHOT), {});

    expect(result.listAlerts).toEqual(expected.listAlerts);
    expect(result.mapFeatures).toEqual(expected.mapFeatures);
    expect(result.snapshot.generated_at_ms).toBe(1751932800000);
  });

  it('falls back to synchronous main-thread parsing when Worker construction throws', async () => {
    FakeWorker.shouldThrowOnConstruct = true;
    const client = new AlertsWorkerClient();
    expect(client.isWorkerActive).toBe(false);

    const result = await client.parseAndBuild(RAW_SNAPSHOT, {});
    expect(result.listAlerts).toHaveLength(1);
    expect(result.listAlerts[0].properties.event).toBe('Tornado Warning');
  });

  it('rejects with the same error a malformed snapshot throws synchronously', async () => {
    const client = new AlertsWorkerClient();
    await expect(client.parseAndBuild({ not: 'a snapshot' }, {})).rejects.toThrow(
      'Snapshot missing generated_at',
    );
  });

  // Efficiency amendment tests, found during review — lock in that a
  // repeat visit to an already-sent state doesn't re-clone/re-post, and
  // that the fallback lookup is only built when the worker is inactive.
  it('sendCounties posts to the worker only once per distinct state code', () => {
    const client = new AlertsWorkerClient();
    expect(client.isWorkerActive).toBe(true);

    client.sendCounties('WI', FAKE_WI_COUNTIES);
    client.sendCounties('WI', FAKE_WI_COUNTIES); // same state, revisited
    expect(FakeWorker.countiesMessageCount).toBe(1);

    client.sendCounties('IL', FAKE_WI_COUNTIES); // different state — DOES post
    expect(FakeWorker.countiesMessageCount).toBe(2);

    client.sendCounties('WI', FAKE_WI_COUNTIES); // back to WI — worker already has it
    expect(FakeWorker.countiesMessageCount).toBe(2);
  });

  it('sendCounties(null, null) always reaches the worker (clears the active state)', () => {
    const client = new AlertsWorkerClient();
    client.sendCounties('WI', FAKE_WI_COUNTIES);
    client.sendCounties(null, null);
    expect(FakeWorker.countiesMessageCount).toBe(2);
  });

  it('falls back mode builds the sync county lookup eagerly (it is the only lookup path there)', async () => {
    FakeWorker.shouldThrowOnConstruct = true;
    const client = new AlertsWorkerClient();
    expect(client.isWorkerActive).toBe(false);

    // No assertion on internals here (syncCountyLookup is private) — the
    // observable proof is behavioral: parseAndBuild's sync fallback must
    // reflect whatever was last sent via sendCounties, matching parity
    // with the worker path's own countyLookup-driven behavior. This case
    // exists primarily as living documentation that fallback mode calls
    // sendCounties synchronously and does not defer/skip the build the way
    // the worker-active path's dedup logic does.
    client.sendCounties('WI', FAKE_WI_COUNTIES);
    const result = await client.parseAndBuild(RAW_SNAPSHOT, {});
    expect(result.listAlerts).toHaveLength(1);
  });

  it('rejects all pending parseAndBuild requests when the worker emits an error', async () => {
    const client = new AlertsWorkerClient();
    const first = client.parseAndBuild(RAW_SNAPSHOT, {});
    const second = client.parseAndBuild(RAW_SNAPSHOT, {});

    FakeWorker.lastInstance?.emitError('boom');

    await expect(first).rejects.toThrow('alerts worker error: boom');
    await expect(second).rejects.toThrow('alerts worker error: boom');
    expect(client.isWorkerActive).toBe(false);
  });

  it('falls back to sync parsing with the last sent county lookup after a worker error', async () => {
    const client = new AlertsWorkerClient();
    client.sendCounties('WI', DANE_COUNTY_FC);

    FakeWorker.lastInstance?.emitError('boom');

    const result = await client.parseAndBuild(RAW_ZONE_ONLY_SNAPSHOT, {});
    expect(result.mapFeatures.features).toHaveLength(1);
    expect(result.mapFeatures.features[0].geometry?.type).toBe('MultiPolygon');
  });

  it('refreshes the retained county reference even when worker county posts are deduped', async () => {
    const client = new AlertsWorkerClient();
    client.sendCounties('WI', FAKE_WI_COUNTIES);
    client.sendCounties('WI', DANE_COUNTY_FC);
    expect(FakeWorker.countiesMessageCount).toBe(1);

    FakeWorker.lastInstance?.emitError('boom');

    const result = await client.parseAndBuild(RAW_ZONE_ONLY_SNAPSHOT, {});
    expect(result.mapFeatures.features).toHaveLength(1);
    expect(result.mapFeatures.features[0].geometry?.type).toBe('MultiPolygon');
  });

  it('rejects an in-flight parseAndBuild request when disposed', async () => {
    const client = new AlertsWorkerClient();
    const pending = client.parseAndBuild(RAW_SNAPSHOT, {});

    client.dispose();

    await expect(pending).rejects.toThrow('alerts worker disposed');
    expect(client.isWorkerActive).toBe(false);
  });
});
