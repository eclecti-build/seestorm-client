'use client';

/**
 * Root-layout error boundary. Next only invokes global-error.tsx when the
 * crash is in the ROOT layout itself (src/app/layout.tsx) or in error.tsx —
 * much rarer than the app/error.tsx path, since layout.tsx here is nearly
 * all static JSX (font vars + <StalenessBanner />). Per Next's contract,
 * global-error REPLACES the root layout entirely (including the <html>/
 * <body> it removes), so it renders its own minimal shell rather than
 * relying on globals.css/Tailwind or StalenessBanner being mounted — see
 * GlobalErrorContent below, kept Tailwind-free and separately exported so
 * it's directly unit-testable without the <html>/<body> wrapper.
 *
 * Static export note: same reasoning as error.tsx — this is a Client
 * Component and the error-boundary wiring is client-side, so it works
 * under `output: 'export'`. Verify with a real `npm run build` (2026-07-08
 * Tier 1 plan, Task 6, Step 9).
 */
export function GlobalErrorContent({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: '28rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
          SeeStorm failed to load
        </h1>
        <p style={{ fontSize: '0.875rem', color: '#d1d5db', marginBottom: '1rem' }}>
          Something went wrong before the page could start. For current watches and warnings, visit{' '}
          <a href="https://www.weather.gov" style={{ color: '#7dd3fc' }}>
            weather.gov
          </a>{' '}
          directly while we fix this.
        </p>
        {error.digest && (
          <p style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '1rem' }}>
            Reference: {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={() => reset()}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '0.25rem',
            background: '#dc2626',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.875rem',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

export default function GlobalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: '#0A0F1A', color: '#fff', fontFamily: 'sans-serif', margin: 0 }}>
        <GlobalErrorContent {...props} />
      </body>
    </html>
  );
}
