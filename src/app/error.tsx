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
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
