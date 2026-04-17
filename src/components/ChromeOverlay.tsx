import Link from 'next/link';

/**
 * ChromeOverlay — "Mode B" radar-first chrome.
 *
 * Positioned absolutely over the map:
 *   - bottom-left:  SeeStorm pill → /about
 *   - bottom-right: stack of [built-by eclecti-build link] + [NWS · Iowa Mesonet tag]
 *
 * This is the full brand surface while the map is the active view.
 * Per brand/README.md: public service tone, never dominant, never above
 * the fold in any marketing sense.  If you are about to add anything here,
 * check the plan first — the viewport belongs to the radar.
 */
export default function ChromeOverlay() {
  return (
    <>
      <Link
        href="/about"
        aria-label="About SeeStorm"
        className="absolute bottom-[calc(18px+env(safe-area-inset-bottom))] left-[calc(0.75rem+env(safe-area-inset-left))] z-10 inline-flex items-center gap-1.5 rounded-full border border-[var(--ss-border)] bg-[rgba(10,15,26,0.85)] px-2.5 py-1.5 text-xs text-[var(--ss-ink)] backdrop-blur-sm transition hover:bg-[rgba(10,15,26,0.95)]"
      >
        <StormEyeMark className="h-3.5 w-3.5" />
        <span className="font-semibold tracking-tight">SeeStorm</span>
      </Link>

      <div className="absolute bottom-[calc(18px+env(safe-area-inset-bottom))] right-[calc(0.75rem+env(safe-area-inset-right))] z-10 flex flex-col items-end gap-1">
        <a
          href="https://eclecti-build.com"
          target="_blank"
          rel="noopener noreferrer"
          title="Built by eclecti-build"
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ss-border)] bg-[rgba(10,15,26,0.85)] py-1 pl-1 pr-2 text-[11px] text-[var(--ss-muted)] opacity-[0.78] backdrop-blur-sm transition hover:opacity-100"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/partners/eclecti-build-mark.svg"
            alt=""
            width={16}
            height={16}
            className="block rounded-sm"
          />
          <span className="text-[var(--ss-faint)]">built by</span>
          <span className="font-medium text-[var(--ss-ink)]">eclecti-build</span>
        </a>
        <div className="inline-flex items-center gap-1.5 rounded bg-[rgba(10,15,26,0.7)] py-0.5 pl-1 pr-1.5 text-[10px] text-[var(--ss-faint)]">
          <Link
            href="/about"
            aria-label="About SeeStorm"
            title="About SeeStorm"
            className="inline-flex items-center text-[var(--ss-ink)] opacity-80 transition hover:opacity-100"
          >
            <StormEyeMark className="h-3.5 w-3.5" />
          </Link>
          <span>NWS · Iowa Mesonet</span>
        </div>
      </div>
    </>
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
        strokeWidth="4"
        opacity="0.55"
      />
      <circle
        cx="34"
        cy="34"
        r="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        opacity="0.85"
      />
      <circle cx="32" cy="32" r="4" fill="var(--ss-primary)" />
    </svg>
  );
}
