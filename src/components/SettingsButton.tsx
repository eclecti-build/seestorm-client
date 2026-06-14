'use client';

import { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import SettingsPanel from './SettingsPanel';

// Gear control. Rendered inside MapControlStack (not a MapLibre IControl) so the
// React-controlled panel needs no portal. Position-agnostic: the stack owns the
// bottom-right anchoring, so this is just a `relative` wrapper holding the button
// and its pop-up panel. ~44px target (Apple HIG min) to match the About button.
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
    <div ref={rootRef} className="relative">
      {open && (
        <div
          role="dialog"
          aria-label="Settings"
          id="settings-dialog"
          className="absolute bottom-full right-0 mb-2 w-64 rounded-lg border border-[var(--ss-border)] bg-[rgba(10,15,26,0.95)] p-3 text-xs text-[var(--ss-ink)] shadow-xl backdrop-blur-sm"
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
        className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--ss-border)] bg-[rgba(10,15,26,0.85)] text-[var(--ss-muted)] shadow-xl backdrop-blur-sm transition hover:bg-[rgba(10,15,26,0.95)] hover:text-[var(--ss-ink)] cursor-pointer"
      >
        <Settings size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
