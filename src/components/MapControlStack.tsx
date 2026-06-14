'use client';

import AboutButton from './AboutButton';
import SettingsButton from './SettingsButton';

// The map's meta-chrome corner. One vertical column of round icon buttons in the
// bottom-right — About on top, Settings (gear) on the bottom where the gear has
// always lived. Replaces the scattered bottom-left/right brand+credit text links
// that users were fat-fingering: fewer, bigger (~44px), well-spaced, deliberate
// targets, lifted clear of the playback band's thumb zone. The bottom offset
// clears that band; spacing keeps the two targets from merging. Required map
// attribution lives separately in MapLibre's compact control (WeatherMap.tsx).
export default function MapControlStack() {
  return (
    <div className="absolute z-20 bottom-[calc(84px+env(safe-area-inset-bottom))] right-[calc(0.75rem+env(safe-area-inset-right))] flex flex-col items-center gap-2.5">
      <AboutButton />
      <SettingsButton />
    </div>
  );
}
