'use client';

import { useRef, useState } from 'react';
import type { ProspectUpdate } from '@/lib/models/prospect';
import type { UserSummary } from '@/lib/models/user';
import { OwnerAvatar } from '@/components/projects/OwnerAvatar';
import { ConfirmModal } from '@/components/shared/ConfirmModal';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeDate(iso: string): string {
  try {
    const d    = new Date(iso);
    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30)  return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

function renderBody(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

function getMentionQuery(text: string, cursor: number): string | null {
  const before  = text.slice(0, cursor);
  const atIdx   = before.lastIndexOf('@');
  if (atIdx === -1) return null;
  const between = before.slice(atIdx + 1);
  if (/[\s]/.test(between)) return null;
  return between;
}

// ── Single update entry ───────────────────────────────────────────────────────

interface EntryProps {
  update:     ProspectUpdate;
  author:     UserSummary | undefined;
  isOwn:      boolean;
  prospectId: string;
  onEdited:   (update: ProspectUpdate) => void;
  onDeleted:  (updateId: string) => void;
  readOnly?:  boolean;
}

function UpdateEntry({ update, author, isOwn, prospectId, onEdited, onDeleted, readOnly }: EntryProps) {
  const [editMode,   setEditMode]   = useState(false);
  const [editText,   setEditText]   = useState(update.body);
  const [saving,     setSaving]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [hovered,    setHovered]    = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function handleSaveEdit() {
    if (!editText.trim()) return;
    setSaving(true);
    try {
      const res  = await fetch(`/api/prospects/${prospectId}/updates/${update.updateId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ body: editText.trim() }),
      });
      const data = await res.json() as { update?: ProspectUpdate };
      if (res.ok && data.update) { onEdited(data.update); setEditMode(false); }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await fetch(`/api/prospects/${prospectId}/updates/${update.updateId}`, { method: 'DELETE' });
      onDeleted(update.updateId);
    } finally {
      setDeleting(false);
      setConfirmDel(false);
    }
  }

  function handleStartEdit() {
    setEditText(update.body);
    setEditMode(true);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.value.length;
      }
    }, 30);
  }

  return (
    <>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ padding: '0.85rem 0', borderBottom: '1px solid var(--line)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {author
              ? <OwnerAvatar user={author} size={26} />
              : <span style={{
                  width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-1)',
                  border: '1px solid var(--line)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: '0.7rem', color: 'var(--muted)',
                }}>?</span>
            }
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-strong)' }}>
              {author?.name ?? 'Unknown'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--muted-soft)' }}>
              {relativeDate(update.createdAt)}
              {update.editedAt && (
                <span style={{ marginLeft: 6, fontStyle: 'italic', opacity: 0.7 }}>(edited)</span>
              )}
            </span>
            {isOwn && !editMode && !readOnly && (
              <div style={{
                display: 'flex', gap: 6,
                opacity: hovered ? 1 : 0,
                transition: 'opacity 120ms ease',
                pointerEvents: hovered ? 'auto' : 'none',
              }}>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  title="Edit"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2, lineHeight: 1 }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDel(true)}
                  title="Delete"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error,#e55)', padding: 2, lineHeight: 1 }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                    <path d="M10 11v6M14 11v6"/>
                    <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {editMode ? (
          <div style={{ marginTop: 4 }}>
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              disabled={saving}
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                padding: '0.45rem 0.65rem', borderRadius: 6,
                border: '1px solid var(--accent)',
                background: 'var(--color-input-bg,#1a1a1a)',
                color: 'inherit', fontSize: '0.875rem', fontFamily: 'inherit', lineHeight: 1.6,
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="modal-btn-ghost"
                style={{ padding: '0.28rem 0.75rem', fontSize: '0.8rem' }}
                onClick={() => { setEditMode(false); setEditText(update.body); }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                style={{ padding: '0.28rem 0.75rem', fontSize: '0.8rem' }}
                onClick={handleSaveEdit}
                disabled={saving || !editText.trim()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <p style={{
            margin: 0, fontSize: '0.875rem', color: 'var(--text)',
            lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {renderBody(update.body)}
          </p>
        )}
      </div>

      {confirmDel && (
        <ConfirmModal
          title="Delete update?"
          body="This update will be permanently removed."
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </>
  );
}

// ── Updates log ───────────────────────────────────────────────────────────────

interface Props {
  prospectId:     string;
  initialUpdates: ProspectUpdate[];
  currentUserId:  string;
  allUsers:       UserSummary[];
  mentionUsers?:  UserSummary[];
  readOnly?:      boolean;
}

export function UpdatesLog({ prospectId, initialUpdates, currentUserId, allUsers, mentionUsers, readOnly }: Props) {
  const [updates,       setUpdates]       = useState<ProspectUpdate[]>(initialUpdates);
  const [compose,       setCompose]       = useState('');
  const [posting,       setPosting]       = useState(false);
  const [focused,       setFocused]       = useState(false);
  const [mentionQuery,  setMentionQuery]  = useState<string | null>(null);
  const [mentionCursor, setMentionCursor] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const userMap = new Map(allUsers.map((u) => [u.id, u]));

  const mentionCandidates = (mentionUsers ?? []).filter((u) =>
    mentionQuery === null
      ? false
      : mentionQuery === '' || u.name.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  async function handlePost() {
    if (!compose.trim()) return;
    setPosting(true);
    try {
      const res  = await fetch(`/api/prospects/${prospectId}/updates`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ body: compose.trim() }),
      });
      const data = await res.json() as { update?: ProspectUpdate };
      if (res.ok && data.update) {
        setUpdates((prev) => [data.update!, ...prev]);
        setCompose('');
        setFocused(false);
        setMentionQuery(null);
      }
    } finally {
      setPosting(false);
    }
  }

  function handleEdited(updated: ProspectUpdate) {
    setUpdates((prev) => prev.map((u) => u.updateId === updated.updateId ? updated : u));
  }

  function handleDeleted(updateId: string) {
    setUpdates((prev) => prev.filter((u) => u.updateId !== updateId));
  }

  function handleComposeChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val    = e.target.value;
    const cursor = e.target.selectionStart ?? val.length;
    setCompose(val);
    const q = getMentionQuery(val, cursor);
    setMentionQuery(q);
    setMentionCursor(0);
  }

  function insertMention(user: UserSummary) {
    const ta     = textareaRef.current;
    const cursor = ta?.selectionStart ?? compose.length;
    const before = compose.slice(0, cursor);
    const after  = compose.slice(cursor);
    const atIdx  = before.lastIndexOf('@');
    const replaced = before.slice(0, atIdx) + `@[${user.name}](${user.id}) ` + after;
    setCompose(replaced);
    setMentionQuery(null);
    setMentionCursor(0);
    setTimeout(() => {
      if (ta) {
        const newPos = atIdx + `@[${user.name}](${user.id}) `.length;
        ta.focus();
        ta.setSelectionRange(newPos, newPos);
      }
    }, 10);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionCursor((c) => Math.min(c + 1, mentionCandidates.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionCandidates[mentionCursor]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handlePost();
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {readOnly && (
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: '0 0 16px', fontStyle: 'italic' }}>
          This prospect has been promoted. No new updates can be added.
        </p>
      )}
      {!readOnly && (
        <div style={{ position: 'relative', marginBottom: 20 }}>
          <div style={{
            border: `1px solid ${focused ? 'var(--accent)' : 'var(--color-border,#444)'}`,
            borderRadius: 8, overflow: 'visible',
            transition: 'border-color 150ms ease',
          }}>
            <textarea
              ref={textareaRef}
              value={compose}
              onChange={handleComposeChange}
              onFocus={() => setFocused(true)}
              onBlur={() => { if (!compose.trim()) setFocused(false); }}
              onKeyDown={handleKeyDown}
              placeholder="Add an update… (@name to mention)"
              disabled={posting}
              rows={focused || compose ? 3 : 1}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'none',
                padding: '0.65rem 0.85rem',
                border: 'none', outline: 'none',
                background: 'transparent',
                color: 'inherit', fontSize: '0.875rem',
                fontFamily: 'inherit', lineHeight: 1.6,
                borderRadius: 8,
              }}
            />
            {(focused || compose) && (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.4rem 0.65rem 0.5rem',
                borderTop: '1px solid var(--line)',
              }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--muted-soft)' }}>
                  ⌘↵ to post · @name to mention
                </span>
                <button
                  type="button"
                  className="modal-btn-primary"
                  style={{ padding: '0.28rem 0.9rem', fontSize: '0.8rem' }}
                  onClick={handlePost}
                  disabled={posting || !compose.trim()}
                >
                  {posting ? 'Posting…' : 'Post'}
                </button>
              </div>
            )}
          </div>

          {/* Mention picker */}
          {mentionQuery !== null && mentionCandidates.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              background: 'var(--surface-1)', border: '1px solid var(--line)',
              borderRadius: 8, padding: '4px 0', minWidth: 200, zIndex: 60,
              boxShadow: 'var(--shadow-md)', maxHeight: 220, overflowY: 'auto',
            }}>
              {mentionCandidates.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '0.4rem 0.75rem',
                    background: i === mentionCursor ? 'rgba(255,255,255,0.08)' : 'none',
                    border: 'none', cursor: 'pointer', textAlign: 'left',
                    color: 'var(--text)', fontSize: '0.875rem',
                  }}
                  onMouseEnter={() => setMentionCursor(i)}
                >
                  <OwnerAvatar user={u} size={22} />
                  <span>{u.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {updates.length === 0 && (
        <p style={{ fontSize: '0.875rem', color: 'var(--muted)', margin: 0 }}>
          {readOnly ? 'No updates were recorded.' : 'No updates yet. Add the first one above.'}
        </p>
      )}
      <div>
        {updates.map((u) => (
          <UpdateEntry
            key={u.updateId}
            update={u}
            author={userMap.get(u.authorId)}
            isOwn={u.authorId === currentUserId}
            prospectId={prospectId}
            onEdited={handleEdited}
            onDeleted={handleDeleted}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
}
