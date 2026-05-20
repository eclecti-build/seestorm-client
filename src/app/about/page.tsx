import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description:
    'SeeStorm is a non-profit, ad-free severe weather visualization for the Great Lakes, built on National Weather Service data.',
};

export default function AboutPage() {
  return (
    <div className="ss-viewport-fill w-full overflow-y-auto bg-[var(--ss-bg)] text-[var(--ss-ink)]">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Link
          href="/"
          className="mb-10 inline-flex items-center gap-2 text-sm text-[var(--ss-muted)] transition hover:text-[var(--ss-ink)]"
          aria-label="Back to map"
        >
          <span aria-hidden="true">←</span> Back to map
        </Link>

        <div className="mb-8 flex items-center gap-3">
          <StormEyeMark className="h-11 w-11 shrink-0 text-[var(--ss-ink)]" />
          <h1 className="text-3xl font-semibold tracking-tight">About SeeStorm</h1>
        </div>

        <section className="mb-10">
          <h2 className="mb-2 text-base font-semibold">Why this exists</h2>
          <p className="text-[var(--ss-ink)]">
            Severe weather data keeps people safe. SeeStorm keeps it free, open, and easy to see. No
            ads, no paywalls, no account required. Built for the Great Lakes.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="mb-2 text-base font-semibold">How it&apos;s built</h2>
          <p className="text-[var(--ss-ink)]">
            Direct from the{' '}
            <a
              href="https://www.weather.gov/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              National Weather Service
            </a>{' '}
            and the{' '}
            <a
              href="https://mesonet.agron.iastate.edu/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              Iowa Environmental Mesonet
            </a>{' '}
            radar service. Watches, warnings, and advisories render as they&apos;re issued, in the
            NWS-standard severity colors. Open-source; operated as a public service by{' '}
            <a
              href="https://eclecti-build.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 align-baseline text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/partners/eclecti-build-mark.svg"
                alt=""
                width={14}
                height={14}
                className="inline-block rounded-[3px]"
              />
              eclecti-build
            </a>
            .
          </p>
        </section>

        <section className="mb-10">
          <h2 className="mb-2 text-base font-semibold">Source</h2>
          <p className="text-[var(--ss-ink)]">
            SeeStorm is open source under the MIT license. Code lives in two repositories:{' '}
            <a
              href="https://github.com/eclecti-build/seestorm-client"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              seestorm-client
            </a>{' '}
            (this site) and{' '}
            <a
              href="https://github.com/eclecti-build/seestorm-ingest"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              seestorm-ingest
            </a>{' '}
            (the NWS data poller). Issues, pull requests, and forks welcome.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="mb-2 text-base font-semibold">Report an issue</h2>
          <p className="text-[var(--ss-ink)]">
            Email{' '}
            <a
              href="mailto:sean@eclecti-build.com"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              sean@eclecti-build.com
            </a>{' '}
            or open an issue on GitHub:{' '}
            <a
              href="https://github.com/eclecti-build/seestorm-client/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              front-end
            </a>{' '}
            for the site or map, or{' '}
            <a
              href="https://github.com/eclecti-build/seestorm-ingest/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--ss-primary)] hover:text-[var(--ss-primary-hover)]"
            >
              data ingestion
            </a>{' '}
            for missing or stale alerts.
          </p>
        </section>

        <footer className="mt-16 border-t border-[var(--ss-border)] pt-6 text-xs text-[var(--ss-faint)]">
          Built by{' '}
          <a
            href="https://eclecti-build.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 align-baseline text-[var(--ss-muted)] hover:text-[var(--ss-ink)]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/partners/eclecti-build-mark.svg"
              alt=""
              width={12}
              height={12}
              className="inline-block rounded-[2px]"
            />
            eclecti-build
          </a>{' '}
          for the Great Lakes. © 2026 SeeStorm contributors · MIT.
        </footer>
      </div>
    </div>
  );
}

function StormEyeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="30"
        cy="30"
        r="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.55"
      />
      <circle
        cx="34"
        cy="34"
        r="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.85"
      />
      <circle cx="32" cy="32" r="4" fill="var(--ss-primary)" />
    </svg>
  );
}
