import { ImageResponse } from 'next/og';

// Static export requires an explicit opt-in for metadata image routes;
// Next.js then evaluates this at build time and emits a static PNG.
export const dynamic = 'force-static';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'SeeStorm — Wisconsin Severe Weather';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        background: 'linear-gradient(135deg, #0A0F1A 0%, #111827 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
        color: '#E5E7EB',
        fontFamily: 'sans-serif',
      }}
    >
      <svg width="200" height="200" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <circle
          cx="30"
          cy="30"
          r="22"
          fill="none"
          stroke="#E5E7EB"
          strokeWidth="3"
          opacity="0.55"
        />
        <circle
          cx="34"
          cy="34"
          r="14"
          fill="none"
          stroke="#E5E7EB"
          strokeWidth="3"
          opacity="0.85"
        />
        <circle cx="32" cy="32" r="4" fill="#38BDF8" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 88, fontWeight: 600, letterSpacing: -1.5 }}>SeeStorm</div>
        <div style={{ fontSize: 28, color: '#94A3B8', maxWidth: 640, lineHeight: 1.3 }}>
          Ad-free, real-time severe weather for Wisconsin. Built on NWS data.
        </div>
      </div>
    </div>,
    { ...size },
  );
}
