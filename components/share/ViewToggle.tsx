'use client';

import { useEffect, useState } from 'react';

/** List / cards switch, shared by the share window and the Add-videos picker (remembered per browser). */
export function ViewToggle({ mode, onChange }: Readonly<{ mode: 'list' | 'cards'; onChange: (m: 'list' | 'cards') => void }>) {
  return (
    <span className="shm-view" role="group" aria-label="View">
      <button type="button" className={mode === 'list' ? 'is-on' : ''} aria-pressed={mode === 'list'} onClick={() => onChange('list')} title="List">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </button>
      <button type="button" className={mode === 'cards' ? 'is-on' : ''} aria-pressed={mode === 'cards'} onClick={() => onChange('cards')} title="Cards">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      </button>
    </span>
  );
}

/** Remembered list/cards choice (per browser). */
export function useViewMode(key: string): ['list' | 'cards', (m: 'list' | 'cards') => void] {
  const [mode, setMode] = useState<'list' | 'cards'>('list');
  useEffect(() => {
    try { const v = window.localStorage.getItem(key); if (v === 'list' || v === 'cards') setMode(v); } catch { /* ignore */ }
  }, [key]);
  const set = (m: 'list' | 'cards') => { setMode(m); try { window.localStorage.setItem(key, m); } catch { /* ignore */ } };
  return [mode, set];
}
