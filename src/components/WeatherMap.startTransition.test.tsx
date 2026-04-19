/**
 * Behavior coverage for the startTransition wrap in WeatherMap.tsx
 * (swarm audit 2026-04-18, Tier 1 #1).
 *
 * The production regression was a 2,104 ms INP on the LIVE pill caused by
 * synchronously applying `setAllAlerts` + `renderFeatures` + `renderMotion`
 * on the click thread. The three calls are now wrapped in React 19's
 * `startTransition(() => { ... })` inside `fetchLive` and `fetchHistorical`.
 *
 * WeatherMap itself is too MapLibre-heavy to render in jsdom, so this suite
 * pins the *pattern* — a fixture component that mirrors the fetch-result
 * apply structure exactly — and asserts the three behaviors required by the
 * swarm audit's Open Decisions #4 (happy + failure + edge):
 *
 *   (a) the transition wrap still applies all three updates in order, so
 *       React commit ordering is preserved.
 *   (b) a throwing fetch path does not leave stale state behind — the error
 *       handler runs and the transition is never entered.
 *   (c) rapid-fire successive fetches don't race — the last-resolved payload
 *       wins and no state update is lost (StrictMode rerender sanity).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  StrictMode,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Snapshot = { alerts: string[]; generatedAt: string };

interface FixtureProps {
  fetchImpl: () => Promise<Snapshot>;
  onRenderFeatures: (alerts: string[]) => void;
  onRenderMotion: (alerts: string[]) => void;
  onError?: (err: unknown) => void;
  triggerRef: { current: (() => Promise<void>) | null };
}

/**
 * Minimal stand-in for the fetch-result state-apply block at
 * WeatherMap.tsx:469-482 and :501-509. Keeps the three ordered operations
 * inside a single startTransition() call so we can pin the exact pattern
 * under test without pulling in MapLibre.
 */
function Fixture({
  fetchImpl,
  onRenderFeatures,
  onRenderMotion,
  onError,
  triggerRef,
}: FixtureProps): ReactNode {
  const [alerts, setAlerts] = useState<string[]>([]);
  const [snapshotTime, setSnapshotTime] = useState<string>('');
  const runCount = useRef(0);

  const run = useCallback(async () => {
    runCount.current += 1;
    try {
      const snapshot = await fetchImpl();
      startTransition(() => {
        setAlerts(snapshot.alerts);
        setSnapshotTime(snapshot.generatedAt);
        onRenderFeatures(snapshot.alerts);
        onRenderMotion(snapshot.alerts);
      });
    } catch (err) {
      onError?.(err);
    }
  }, [fetchImpl, onRenderFeatures, onRenderMotion, onError]);

  useEffect(() => {
    triggerRef.current = run;
    return () => {
      triggerRef.current = null;
    };
  }, [run, triggerRef]);

  return (
    <div>
      <span data-testid="count">{alerts.length}</span>
      <span data-testid="time">{snapshotTime}</span>
      <ul>
        {alerts.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

describe('WeatherMap fetch-result startTransition wrap', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('(happy path) applies setAllAlerts, renderFeatures, and renderMotion in order with the same payload', async () => {
    const renderFeatures = vi.fn();
    const renderMotion = vi.fn();
    const triggerRef: { current: (() => Promise<void>) | null } = { current: null };

    const payload: Snapshot = {
      alerts: ['TO.A', 'STW.B', 'FF.C'],
      generatedAt: '2026-04-17T20:00:00Z',
    };

    render(
      <Fixture
        fetchImpl={() => Promise.resolve(payload)}
        onRenderFeatures={renderFeatures}
        onRenderMotion={renderMotion}
        triggerRef={triggerRef}
      />,
    );

    await act(async () => {
      await triggerRef.current!();
    });

    // All three effects fired exactly once with the same payload the alert
    // state was set to. Order matters: renderFeatures must run before
    // renderMotion so the map source exists when motion arrows query it.
    expect(renderFeatures).toHaveBeenCalledTimes(1);
    expect(renderFeatures).toHaveBeenCalledWith(payload.alerts);
    expect(renderMotion).toHaveBeenCalledTimes(1);
    expect(renderMotion).toHaveBeenCalledWith(payload.alerts);

    const featuresCallOrder = renderFeatures.mock.invocationCallOrder[0];
    const motionCallOrder = renderMotion.mock.invocationCallOrder[0];
    expect(featuresCallOrder).toBeLessThan(motionCallOrder);

    // State reflects the transition's commit.
    expect(screen.getByTestId('count').textContent).toBe('3');
    expect(screen.getByTestId('time').textContent).toBe(payload.generatedAt);
  });

  it('(failure path) does not throw and skips the state apply when fetch rejects', async () => {
    const renderFeatures = vi.fn();
    const renderMotion = vi.fn();
    const onError = vi.fn();
    const triggerRef: { current: (() => Promise<void>) | null } = { current: null };
    const boom = new Error('network blew up');

    render(
      <Fixture
        fetchImpl={() => Promise.reject(boom)}
        onRenderFeatures={renderFeatures}
        onRenderMotion={renderMotion}
        onError={onError}
        triggerRef={triggerRef}
      />,
    );

    await act(async () => {
      await triggerRef.current!();
    });

    // Error was caught and surfaced; the transition body never ran, so state
    // stays at its initial empty value and no renderers were invoked.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(renderFeatures).not.toHaveBeenCalled();
    expect(renderMotion).not.toHaveBeenCalled();
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(screen.getByTestId('time').textContent).toBe('');
  });

  it('(edge — rapid-fire under StrictMode) last-resolved fetch wins and no update is dropped', async () => {
    const renderFeatures = vi.fn();
    const renderMotion = vi.fn();
    const triggerRef: { current: (() => Promise<void>) | null } = { current: null };

    // Two successive fetches — simulate a user spamming LIVE then dragging
    // the slider. Both resolve in order; the transition coalesces commits
    // but must not lose the second payload.
    const first: Snapshot = { alerts: ['A'], generatedAt: 't1' };
    const second: Snapshot = { alerts: ['A', 'B'], generatedAt: 't2' };

    let call = 0;
    const fetchImpl = (): Promise<Snapshot> => {
      call += 1;
      return Promise.resolve(call === 1 ? first : second);
    };

    render(
      <StrictMode>
        <Fixture
          fetchImpl={fetchImpl}
          onRenderFeatures={renderFeatures}
          onRenderMotion={renderMotion}
          triggerRef={triggerRef}
        />
      </StrictMode>,
    );

    await act(async () => {
      await triggerRef.current!();
      await triggerRef.current!();
    });

    // Both fetches applied; the visible state reflects the *second* payload.
    expect(renderFeatures).toHaveBeenCalledTimes(2);
    expect(renderMotion).toHaveBeenCalledTimes(2);
    expect(renderFeatures).toHaveBeenLastCalledWith(second.alerts);
    expect(renderMotion).toHaveBeenLastCalledWith(second.alerts);

    // StrictMode double-invokes render bodies in dev but not effects/events;
    // the committed state should still reflect the last resolved payload.
    expect(screen.getByTestId('count').textContent).toBe('2');
    expect(screen.getByTestId('time').textContent).toBe('t2');
  });
});
