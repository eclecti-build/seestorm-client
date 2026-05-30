'use client';

import { useEffect, useRef, useState } from 'react';
import SettingsPanel from './SettingsPanel';

// Gear control. Mounted as a fixed overlay (not a MapLibre IControl) so the
// React-controlled panel needs no portal. Bottom-right keeps it clear of the
// top-left alerts/legend column and the top-right MapLibre nav/geolocate
// controls. Placement is a known verify-time tunable.
export default function SettingsButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="fixed z-30 bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))]"
    >
      {open && (
        <div
          role="dialog"
          aria-label="Settings"
          id="settings-dialog"
          className="absolute bottom-full right-0 mb-2 w-64 bg-gray-900/95 text-white text-xs rounded-lg shadow-xl border border-gray-700 p-3"
        >
          <SettingsPanel />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Settings"
        aria-controls="settings-dialog"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-900/95 text-gray-200 shadow-xl border border-gray-700 hover:bg-gray-800 cursor-pointer"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M19.4 13a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 7 19.3l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 13H4.5a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 6.7 6.13l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 11 3.6V3.5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 20.4 11h.1a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.01.99Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </button>
    </div>
  );
}
