'use client';

/**
 * Route-segment error boundary for everything under the root layout (the
 * map page, /about). Catches a render/lifecycle crash in the tree below
 * `{children}` in src/app/layout.tsx — e.g. a bug in WeatherMap's ~2000
 * line render path — WITHOUT unmounting the layout itself, so
 * <StalenessBanner /> (a sibling of {children} in layout.tsx, not a
 * descendant) stays mounted and keeps giving an honest signal even while
 * the page content has crashed.
 *
 * Static export note: error.tsx is a Client Component and the App Router
 * error-boundary mechanism it relies on is implemented entirely
 * client-side (a React error boundary Next wraps around each route
 * segment's rendered output) — it does not require a Node.js server, so it
 * is compatible with `output: 'export'` in next.config.ts. Verify with a
 * real `npm run build` plus a manual thrown-error check before shipping
 * (2026-07-08 Tier 1 plan, Task 6, Step 9).
 */
// Mirrors ChunkErrorBanner.tsx's reload-loop guard and CHUNK_ERROR_PATTERN
// (src/components/ChunkErrorBanner.tsx) — both files need to share the SAME
// reload knowledge and recognize the SAME failure signature (a failed dynamic
// import surfacing either as a bare window error/rejection event, which
// ChunkErrorBanner listens for, or as a render-time throw caught here).
// Deliberately duplicated rather than imported from a shared module: this
// task's review explicitly keeps ChunkErrorBanner.tsx unmodified/standalone.
// If the guard or failure-text set is ever changed in one file, change it here
// too — check both call sites together. The `Failed to load chunk ... from
// module N` Turbopack phrasing is empirically confirmed by a 2026-07-09
// Playwright run against this repo's real production build.
// See ChunkErrorBanner.tsx's header for the accepted visual-overlap edge when a failure surfaces through both channels.
const RELOAD_GUARD_KEY = 'seestorm:chunk-reload-at';
const RELOAD_GUARD_WINDOW_MS = 15_000;

const CHUNK_ERROR_PATTERN =
  /ChunkLoadError|Loading chunk [\w.-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

function isChunkLoadFailure(error: Error): boolean {
  return CHUNK_ERROR_PATTERN.test(`${error.name ?? ''} ${error.message ?? ''}`);
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

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  if (isChunkLoadFailure(error)) {
    const hasRecentReload = recentlyReloaded();
    const handleReload = () => {
      markReloaded();
      window.location.reload();
    };

    // Chunk-load-skew branch (Tier 3 #4): a stale tab's dynamic import
    // (`dynamic(() => import('@/components/WeatherMap'), { ssr: false })`)
    // threw because the previous build's chunk no longer exists post-deploy.
    // reset() only re-attempts rendering the SAME already-loaded (and still-
    // broken) module tree — it does not re-fetch the build manifest, so it
    // can't fix a genuinely missing chunk. A full reload is the only action
    // that actually resolves this, and — per this app's life-safety framing,
    // same principle as ChunkErrorBanner — it is ALWAYS a one-click,
    // user-initiated action, never automatic: an unannounced reload could
    // interrupt someone reading an active tornado warning mid-session.
    return (
      <div
        role="alert"
        className="min-h-screen flex items-center justify-center bg-gray-950 text-white p-6"
      >
        <div className="max-w-md text-center space-y-4">
          <div className="text-xl font-semibold">
            {hasRecentReload ? 'Still having trouble loading' : 'App updated'}
          </div>
          <p className="text-sm text-gray-300">
            {hasRecentReload
              ? 'Check your connection and try again shortly.'
              : 'SeeStorm was updated while this tab was open. Reload to get the latest version.'}
          </p>
          <p className="text-sm text-gray-300">
            If reloading does not help, visit{' '}
            <a
              href="https://www.weather.gov"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-300 underline underline-offset-2"
            >
              weather.gov
            </a>{' '}
            for current watches and warnings.
          </p>
          <button
            type="button"
            onClick={handleReload}
            className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-sm font-semibold"
            data-testid="route-error-chunk-reload"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  // Generic crash — Tier 1's ORIGINAL, UNCHANGED branch. Pinned by this
  // file's pre-existing error.test.tsx cases; do not alter this branch's
  // text/roles/structure without coordinating with the Tier 1 plan.
  return (
    <div
      role="alert"
      className="min-h-screen flex items-center justify-center bg-gray-950 text-white p-6"
    >
      <div className="max-w-md text-center space-y-4">
        <div className="text-xl font-semibold">SeeStorm hit an unexpected error</div>
        <p className="text-sm text-gray-300">
          Something went wrong loading this page. For current watches and warnings, visit{' '}
          <a
            href="https://www.weather.gov"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-300 underline underline-offset-2"
          >
            weather.gov
          </a>{' '}
          directly while we fix this.
        </p>
        {error.digest && <p className="text-xs text-gray-500">Reference: {error.digest}</p>}
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 text-sm font-semibold"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-sm font-semibold"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
