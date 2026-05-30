'use client';

import { useColorVisionMode, setColorVisionMode } from '@/lib/preferences';

// The settings body. v1 carries exactly one control; it's a component of its
// own so it can be unit-tested in isolation and so the gear popover stays a
// thin shell. Future preferences slot in here.
export default function SettingsPanel() {
  const mode = useColorVisionMode();
  const on = mode === 'cbFriendly';

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">Accessibility</div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Colorblind-friendly colors"
        onClick={() => setColorVisionMode(on ? 'default' : 'cbFriendly')}
        className="w-full flex items-center gap-3 rounded px-1.5 py-1 text-left transition-colors cursor-pointer hover:bg-gray-800"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            on ? 'bg-emerald-500' : 'bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              on ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </span>
        <span className="flex-1 leading-tight">
          Colorblind-friendly colors
          <span className="block text-[10px] text-gray-400">
            Swaps alert, tornado &amp; radar colors for a CVD-safe palette
          </span>
        </span>
      </button>
    </div>
  );
}
