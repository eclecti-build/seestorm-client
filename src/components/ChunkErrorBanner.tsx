'use client';

/**
 * Chunk-load-skew banner (Tier 3 #4).
 *
 * SeeStorm is a Next.js static export deployed atomically to Cloudflare
 * Workers + Static Assets. A browser tab left open across a deploy holds
 * HTML referencing content-hashed /_next/static/chunks/*.js filenames from
 * the PREVIOUS build. If that tab later triggers a dynamic import (e.g. the
 * `dynamic(() => import('@/components/WeatherMap'), { ssr: false })` map
 * bundle), the browser requests a chunk file that no longer exists post-
 * deploy. Verified: Cloudflare Workers Static Assets has no documented
 * mechanism to retain a previous deployment's assets — the only related
 * feature (gradual-rollout version affinity) needs an explicit staged
 * rollout this project's single-shot auto-deploy doesn't use.
 *
 * This component listens for the browser's failed-dynamic-import signals
 * and offers a ONE-CLICK, user-initiated reload. It never auto-reloads —
 * an unannounced reload could interrupt someone reading an active tornado
 * warning. See also `src/app/error.tsx`, a companion React error boundary
 * for the case where the same failure surfaces as a render-time throw
 * instead of a bare window event.
 */

import { useEffect, useState } from 'react';

const RELOAD_GUARD_KEY = 'seestorm:chunk-reload-at';
const RELOAD_GUARD_WINDOW_MS = 15_000;

// Mirrors src/app/error.tsx's CHUNK_ERROR_PATTERN — both files need to
// recognize the SAME failure signature (a failed dynamic import surfacing
// either as a bare window error/rejection event here, or as a render-time
// throw caught by the route error boundary). Deliberately duplicated rather
// than imported from a shared module: this component stays standalone so it
// can hedge non-lazy import failures. If the failure-text set is ever widened
// in one file, widen it in the other too. The `Failed to load chunk ... from
// module N` Turbopack phrasing is empirically confirmed by a 2026-07-09
// Playwright run against this repo's real production build.
const CHUNK_ERROR_PATTERN =
  /ChunkLoadError|Loading chunk [\w.-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

function isChunkLoadFailure(message: string | undefined | null): boolean {
  if (!message) return false;
  return CHUNK_ERROR_PATTERN.test(message);
}

function recentlyReloaded(): boolean {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < RELOAD_GUARD_WINDOW_MS;
  } catch {
    // Private-browsing / storage-disabled: fail open — worst case is one
    // extra reload prompt, never a crash.
    return false;
  }
}

function markReloaded(): void {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Ignore — the guard degrades to "always offer reload", which is safe.
  }
}

type BannerState = 'hidden' | 'offerReload' | 'loopDetected';

export default function ChunkErrorBanner() {
  const [state, setState] = useState<BannerState>('hidden');

  useEffect(() => {
    function handleFailure(message: string | undefined | null) {
      if (!isChunkLoadFailure(message)) return;
      setState(recentlyReloaded() ? 'loopDetected' : 'offerReload');
    }

    function onError(event: ErrorEvent) {
      handleFailure(event.message ?? event.error?.message);
    }
    function onRejection(event: PromiseRejectionEvent) {
      const reason: unknown = event.reason;
      const message =
        typeof reason === 'string'
          ? reason
          : reason instanceof Error
            ? `${reason.name ?? ''} ${reason.message ?? ''}`
            : undefined;
      handleFailure(message);
    }

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  if (state === 'hidden') return null;

  const handleReload = () => {
    markReloaded();
    window.location.reload();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="chunk-error-banner"
      className="fixed bottom-0 inset-x-0 z-50 bg-amber-600 text-white text-center text-sm sm:text-base font-semibold px-4 py-2 shadow-lg flex items-center justify-center gap-3"
      style={{
        paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))',
        paddingLeft: 'calc(1rem + env(safe-area-inset-left))',
        paddingRight: 'calc(1rem + env(safe-area-inset-right))',
      }}
    >
      {state === 'offerReload' ? (
        <>
          <span>App updated — reload to get the latest version.</span>
          <button
            type="button"
            onClick={handleReload}
            className="underline font-bold shrink-0"
            data-testid="chunk-error-reload"
          >
            Reload
          </button>
        </>
      ) : (
        <span>Still having trouble loading — check your connection and try again shortly.</span>
      )}
    </div>
  );
}
