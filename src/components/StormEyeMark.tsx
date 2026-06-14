/**
 * StormEyeMark — the SeeStorm brand glyph (an off-center radar "eye").
 * Shared so the map chrome and any future surface render an identical mark;
 * `currentColor` lets the caller theme it. Decorative by default — callers that
 * use it as the sole content of an interactive control must supply their own
 * accessible label (e.g. aria-label on the link/button).
 */
export default function StormEyeMark({ className }: { className?: string }) {
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
