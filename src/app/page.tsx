'use client';

import dynamic from 'next/dynamic';
import ChromeOverlay from '@/components/ChromeOverlay';

const WeatherMap = dynamic(() => import('@/components/WeatherMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full ss-viewport-fill bg-gray-950 flex items-center justify-center">
      <div className="text-gray-400 text-lg">Loading map...</div>
    </div>
  ),
});

export default function Home() {
  return (
    <main className="relative w-full ss-viewport-fill">
      <WeatherMap />
      <ChromeOverlay />
    </main>
  );
}
