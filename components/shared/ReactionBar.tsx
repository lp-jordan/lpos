'use client';

import { useEffect, useRef, useState } from 'react';
import { REACTION_EMOJIS } from '@/lib/models/reaction';
import type { MessageReaction } from '@/lib/models/reaction';

/** Shared emoji-reaction strip for message-style entries (people updates,
 *  task comments). Presentational only — the caller owns persistence and
 *  passes the settled reaction set back down.
 *
 *  The add button sits at low opacity rather than appearing on row hover: the
 *  entries this renders under already use hover for edit/delete affordances,
 *  and a second hover-revealed control in the same row reads as jumpy. */

interface Props {
  reactions:     MessageReaction[];
  currentUserId: string;
  /** userId → display name, for the "who reacted" tooltip. Missing ids fall
   *  back to "Someone" rather than leaking a raw uuid. */
  userNames?:    Map<string, string>;
  onToggle:      (emoji: string) => void;
  /** Read-only surfaces (e.g. promoted prospects) still show tallies. */
  disabled?:     boolean;
}

function tooltip(userIds: string[], userNames: Map<string, string> | undefined, currentUserId: string): string {
  return userIds
    .map((id) => (id === currentUserId ? 'You' : userNames?.get(id) ?? 'Someone'))
    .join(', ');
}

export function ReactionBar({ reactions, currentUserId, userNames, onToggle, disabled }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPickerOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const visible = reactions.filter((r) => r.userIds.length > 0);
  if (disabled && visible.length === 0) return null;

  function handlePick(emoji: string) {
    setPickerOpen(false);
    onToggle(emoji);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 8 }}>
      {visible.map((r) => {
        const mine = r.userIds.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            type="button"
            title={tooltip(r.userIds, userNames, currentUserId)}
            onClick={() => { if (!disabled) onToggle(r.emoji); }}
            disabled={disabled}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '0.1rem 0.42rem', borderRadius: 999,
              border: `1px solid ${mine ? 'var(--accent)' : 'var(--line)'}`,
              background: mine ? 'rgba(212,150,10,0.14)' : 'var(--surface-1)',
              color: 'var(--text)', fontSize: '0.78rem', lineHeight: 1.7,
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            <span style={{ fontSize: '0.85rem' }}>{r.emoji}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: mine ? 'var(--accent-strong)' : 'var(--muted)' }}>
              {r.userIds.length}
            </span>
          </button>
        );
      })}

      {!disabled && (
        <button
          type="button"
          title="Add reaction"
          onClick={() => setPickerOpen((o) => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 22, borderRadius: 999,
            border: '1px solid var(--line)', background: 'transparent',
            color: 'var(--muted)', cursor: 'pointer', padding: 0,
            opacity: pickerOpen ? 1 : 0.55, transition: 'opacity 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { if (!pickerOpen) e.currentTarget.style.opacity = '0.55'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M8.5 14.5a4 4 0 007 0" />
            <line x1="9" y1="9.5" x2="9.01" y2="9.5" />
            <line x1="15" y1="9.5" x2="15.01" y2="9.5" />
          </svg>
        </button>
      )}

      {pickerOpen && !disabled && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 6,
          display: 'flex', gap: 2, padding: '4px 5px',
          background: 'var(--surface-1)', border: '1px solid var(--line)',
          borderRadius: 8, boxShadow: 'var(--shadow-md)', zIndex: 60,
        }}>
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => handlePick(emoji)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '1.05rem', lineHeight: 1, padding: '3px 4px', borderRadius: 6,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
