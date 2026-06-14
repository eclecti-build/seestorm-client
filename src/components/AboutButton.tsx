import Link from 'next/link';
import StormEyeMark from './StormEyeMark';

// The brand/about entry point on the map. Replaces the old bottom-left SeeStorm
// pill: a single deliberate ~44px round target (Apple HIG min) carrying the
// storm-eye mark, sized and styled to match the gear so they read as one stack.
// Lives inside MapControlStack, which owns positioning.
export default function AboutButton() {
  return (
    <Link
      href="/about"
      aria-label="About SeeStorm"
      className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--ss-border)] bg-[rgba(10,15,26,0.85)] text-[var(--ss-muted)] shadow-xl backdrop-blur-sm transition hover:bg-[rgba(10,15,26,0.95)] hover:text-[var(--ss-ink)]"
    >
      <StormEyeMark className="h-5 w-5" />
    </Link>
  );
}
