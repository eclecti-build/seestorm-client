/**
 * Behavior coverage for the airtight refresh loop pattern in WeatherMap.tsx
 * (swarm audit 2026-04-18, Tier 1 #2c).
 *
 * WeatherMap itself is MapLibre-heavy and doesn't render in jsdom, so —
 * following the precedent set in WeatherMap.startTransition.test.tsx —
 * this suite pins the *pattern* via a fixture component that mirrors the
 * production effect exactly:
 *
 *   - AbortController owned by each effect run, aborted on unmount and on
 *     state-transition cleanup so no setState-after-unmount happens.
 *   - Visibilitychange + focus listeners installed, fire a refetch when
 *     the tab returns to visible.
 *   - Retry via fetchJsonWithRetry. No fetch loop that silently eats the
 *     first failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { fetchJsonWithRetry, isAbortError } from '@/lib/fetchWithRetry';

interface PollFixtureProps {
  url: string;
  onData: (data: unknown) => void;
  onError?: (err: unknown) => void;
}

/**
 * Miniature copy of the WeatherMap live-poll effect. Same abort discipline,
 * same visibilitychange + focus listeners, same `fetchJsonWithRetry` call.
 */
function PollFixture({ url, onData, onError }: PollFixtureProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const run = async (): Promise<void> => {
      try {
        const data = await fetchJsonWithRetry(url, { signal });
        onData(data);
      } catch (err) {
        if (isAbortError(err)) return;
        onError?.(err);
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, 30_000);

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    const onFocus = (): void => {
      void run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      controller.abort();
    };
  }, [url, onData, onError, tick]);

  return <button onClick={() => setTick((t) => t + 1)}>bump</button>;
}

describe('WeatherMap refresh-loop pattern', () => {
  const realFetch = globalThis.fetch;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('aborts the in-flight fetch on unmount (no setState-after-unmount)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    // Fetch that never resolves unless the caller aborts it.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const onData = vi.fn();
    const onError = vi.fn();
    const { unmount } = render(
      <PollFixture url="/v1/active-events.json" onData={onData} onError={onError} />,
    );

    // Fetch was kicked off by the effect.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Unmount → AbortController aborts → isAbortError swallows → no setState.
    await act(async () => {
      unmount();
      // Let any pending microtasks settle so the abort rejection propagates.
      await Promise.resolve();
    });

    // The onData callback must never have been called, AND onError must not
    // have been called (abort is silent). No warnings about setState-after-
    // unmount should hit the console spy.
    expect(onData).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/can't perform a React state update on an unmounted/i),
    );
  });

  it('fires an immediate refetch on visibilitychange → visible', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ping: 1 }),
    });

    const onData = vi.fn();
    render(<PollFixture url="/v1/active-events.json" onData={onData} />);

    // Initial fetch on mount.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a tab becoming visible.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fires an immediate refetch on window focus', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ping: 1 }),
    });

    const onData = vi.fn();
    render(<PollFixture url="/v1/active-events.json" onData={onData} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('removes visibilitychange + focus listeners on unmount', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ping: 1 }),
    });

    const { unmount } = render(<PollFixture url="/v1/active-events.json" onData={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });
    const callCountAfterMount = fetchMock.mock.calls.length;

    unmount();

    // Events fired post-unmount must not trigger a new fetch.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBe(callCountAfterMount);
  });
});
