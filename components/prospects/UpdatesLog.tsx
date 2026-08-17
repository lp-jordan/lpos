'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { ProspectStatus, ProspectUpdate, ProspectUpdateAttachment } from '@/lib/models/prospect';
import type { MessageReaction } from '@/lib/models/reaction';
import type { UserSummary } from '@/lib/models/user';
import { OwnerAvatar } from '@/components/projects/OwnerAvatar';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { ReactionBar } from '@/components/shared/ReactionBar';
import { NewTaskModal } from '@/components/dashboard/NewTaskModal';

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

// ── Link / mention parsing ────────────────────────────────────────────────────

const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;
const URL_RE     = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)/]/g;

type Segment =
  | { type: 'text';    text: string }
  | { type: 'mention'; name: string }
  | { type: 'url';     href: string };

function parseSegments(text: string): Segment[] {
  const hits: { index: number; length: number; seg: Segment }[] = [];

  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    hits.push({ index: m.index, length: m[0].length, seg: { type: 'mention', name: m[1] } });
  }
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    hits.push({ index: m.index, length: m[0].length, seg: { type: 'url', href: m[0] } });
  }

  hits.sort((a, b) => a.index - b.index);

  const out: Segment[] = [];
  let pos = 0;
  for (const { index, length, seg } of hits) {
    if (index < pos) continue; // inside a previous match (shouldn't happen but guard it)
    if (index > pos) out.push({ type: 'text', text: text.slice(pos, index) });
    out.push(seg);
    pos = index + length;
  }
  if (pos < text.length) out.push({ type: 'text', text: text.slice(pos) });
  return out;
}

const ROUTE_LABELS: Record<string, string> = {
  prospects: 'Prospect', projects: 'Project', people: 'People',
  settings:  'Settings', dashboard: 'Dashboard', platform: 'Platform', queue: 'Queue',
};
const ID_RE = /^[0-9a-f-]{8,}$|^[\w-]{20,}$/i;

function toLabel(seg: string): string {
  return ROUTE_LABELS[seg] ?? (seg[0].toUpperCase() + seg.slice(1).replace(/-/g, ' '));
}

function abbreviateUrl(href: string): string {
  try {
    const url        = new URL(href);
    const isInternal = typeof window !== 'undefined' && url.hostname === window.location.hostname;
    if (isInternal) {
      const segs = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      if (segs[0] === 'projects' && segs[1] === 'clients' && segs[2]) {
        const client = segs[2];
        const sub    = segs[4] && !ID_RE.test(segs[4]) ? toLabel(segs[4]) : 'Project';
        return `${client}: ${sub}`;
      }
      for (let i = segs.length - 1; i >= 0; i--) {
        if (!ID_RE.test(segs[i])) return toLabel(segs[i]);
      }
      return 'Link';
    }
    return url.hostname.replace(/^www\./, '');
  } catch {
    return href.length > 50 ? href.slice(0, 47) + '…' : href;
  }
}

const labelCache = new Map<string, string>();
const UUID_RE    = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function needsResolution(href: string): boolean {
  try {
    const u = new URL(href);
    return typeof window !== 'undefined' && u.hostname === window.location.hostname && UUID_RE.test(u.pathname);
  } catch { return false; }
}

const LINK_STYLE: React.CSSProperties = {
  color: '#d4960a', fontWeight: 500, textDecoration: 'underline',
  textDecorationStyle: 'dotted', textUnderlineOffset: 2,
};

function LinkToken({ href }: { href: string }) {
  const [label, setLabel] = useState<string>(() => labelCache.get(href) ?? abbreviateUrl(href));
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!needsResolution(href)) return;
    if (labelCache.has(href)) { setLabel(labelCache.get(href)!); return; }
    fetch(`/api/link-label?url=${encodeURIComponent(href)}`)
      .then((r) => r.json())
      .then((d: { label?: string | null }) => {
        if (d.label) {
          labelCache.set(href, d.label);
          startTransition(() => setLabel(d.label!));
        }
      })
      .catch(() => {});
  }, [href]);

  return <a href={href} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>{label}</a>;
}

function renderBody(text: string): React.ReactNode {
  const segs = parseSegments(text);
  if (segs.length === 0) return text;
  return segs.map((seg, i) => {
    if (seg.type === 'text')    return <span key={i}>{seg.text}</span>;
    if (seg.type === 'mention') return (
      <span key={i} style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>@{seg.name}</span>
    );
    return <LinkToken key={i} href={seg.href} />;
  });
}

function getMentionQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const atIdx  = before.lastIndexOf('@');
  if (atIdx === -1) return null;
  const between = before.slice(atIdx + 1);
  if (/[\s]/.test(between)) return null;
  return between;
}

// ── Attachment display ────────────────────────────────────────────────────────

function AttachmentChip({ a }: { a: ProspectUpdateAttachment }) {
  const url     = `/api/attachment?key=${encodeURIComponent(a.key)}`;
  const isImage = a.mime.startsWith('image/');

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={a.name}
          style={{ display: 'block', maxWidth: 220, maxHeight: 160, objectFit: 'cover' }}
        />
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={a.name}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '0.3rem 0.65rem', borderRadius: 6,
        border: '1px solid var(--line)', background: 'var(--surface-1)',
        color: 'var(--text)', fontSize: '0.8rem', textDecoration: 'none',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
    </a>
  );
}

// ── Pending upload chip (compose area) ────────────────────────────────────────

interface PendingAttachment extends ProspectUpdateAttachment {
  uploading?: boolean;
  error?:     string;
}

function PendingChip({ p, onRemove }: { p: PendingAttachment; onRemove: () => void }) {
  const isImage = p.mime.startsWith('image/');
  const label   = p.uploading ? 'Uploading…' : p.error ? 'Failed' : p.name;

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '0.25rem 0.5rem', borderRadius: 6,
      border: `1px solid ${p.error ? 'var(--color-error,#e55)' : 'var(--line)'}`,
      background: 'var(--surface-1)', fontSize: '0.78rem', color: 'var(--text)',
      opacity: p.uploading ? 0.6 : 1,
    }}>
      {isImage
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      }
      <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {!p.uploading && (
        <button
          type="button"
          onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, lineHeight: 1, marginLeft: 2 }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      )}
    </div>
  );
}

// ── Single update entry ───────────────────────────────────────────────────────

interface EntryProps {
  update:        ProspectUpdate;
  author:        UserSummary | undefined;
  isOwn:         boolean;
  currentUserId: string;
  userNames:     Map<string, string>;
  prospectId:    string;
  onEdited:      (update: ProspectUpdate) => void;
  onDeleted:     (updateId: string) => void;
  onReacted:     (updateId: string, reactions: MessageReaction[]) => void;
  readOnly?:     boolean;
}

function UpdateEntry({ update, author, isOwn, currentUserId, userNames, prospectId, onEdited, onDeleted, onReacted, readOnly }: EntryProps) {
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

  /** Optimistic: the pill flips immediately, then the server's settled set
   *  replaces it. On failure we roll back to the pre-click state so a dropped
   *  request can't leave a phantom reaction on screen. */
  async function handleToggleReaction(emoji: string) {
    const before = update.reactions;
    const mine   = before.find((r) => r.emoji === emoji)?.userIds.includes(currentUserId) ?? false;

    const optimistic = mine
      ? before
          .map((r) => r.emoji === emoji ? { ...r, userIds: r.userIds.filter((id) => id !== currentUserId) } : r)
          .filter((r) => r.userIds.length > 0)
      : before.some((r) => r.emoji === emoji)
        ? before.map((r) => r.emoji === emoji ? { ...r, userIds: [...r.userIds, currentUserId] } : r)
        : [...before, { emoji, userIds: [currentUserId] }];

    onReacted(update.updateId, optimistic);

    try {
      const res  = await fetch(`/api/prospects/${prospectId}/updates/${update.updateId}/reactions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ emoji }),
      });
      const data = await res.json() as { reactions?: MessageReaction[] };
      if (res.ok && data.reactions) onReacted(update.updateId, data.reactions);
      else onReacted(update.updateId, before);
    } catch {
      onReacted(update.updateId, before);
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

        {/* Attachments */}
        {update.attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {update.attachments.map((a) => <AttachmentChip key={a.key} a={a} />)}
          </div>
        )}

        {!editMode && (
          <ReactionBar
            reactions={update.reactions ?? []}
            currentUserId={currentUserId}
            userNames={userNames}
            onToggle={(emoji) => { void handleToggleReaction(emoji); }}
            disabled={readOnly}
          />
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
  /** Used to pre-fill (and lock) the client picker on the inline NewTaskModal
   *  opened from the task icon next to the attach button. */
  companyName:    string;
  /** Drives the inline task icon's default taskType: 'preprod' for prospects,
   *  no default for active/inactive clients (the modal shows its picker). */
  personStatus:   ProspectStatus;
  initialUpdates: ProspectUpdate[];
  currentUserId:  string;
  allUsers:       UserSummary[];
  mentionUsers?:  UserSummary[];
  readOnly?:      boolean;
}

export function UpdatesLog({ prospectId, companyName, personStatus, initialUpdates, currentUserId, allUsers, mentionUsers, readOnly }: Props) {
  const [updates,       setUpdates]       = useState<ProspectUpdate[]>(initialUpdates);
  const [compose,       setCompose]       = useState('');
  const [posting,       setPosting]       = useState(false);
  const [focused,       setFocused]       = useState(false);
  const [mentionQuery,  setMentionQuery]  = useState<string | null>(null);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [pending,       setPending]       = useState<PendingAttachment[]>([]);
  const [dragOver,      setDragOver]      = useState(false);
  const [showNewTask,   setShowNewTask]   = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Mirrors the user's spec: auto-default to Pre-Production for prospects;
   *  no default for active/inactive clients (the modal renders its own picker). */
  const defaultTaskType = personStatus === 'prospect' ? 'preprod' : undefined;

  const userMap   = new Map(allUsers.map((u) => [u.id, u]));
  const userNames = new Map(allUsers.map((u) => [u.id, u.name]));

  const mentionCandidates = (mentionUsers ?? []).filter((u) =>
    mentionQuery === null
      ? false
      : mentionQuery === '' || u.name.toLowerCase().includes(mentionQuery.toLowerCase()),
  );

  const hasUploading = pending.some((p) => p.uploading);

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function uploadFile(file: File) {
    const tempKey = `pending-${Math.random()}`;
    const stub: PendingAttachment = { key: tempKey, name: file.name, mime: file.type, size: file.size, uploading: true };
    setPending((prev) => [...prev, stub]);

    const form = new FormData();
    form.append('file', file);

    try {
      const res  = await fetch(`/api/prospects/${prospectId}/updates/attachments`, { method: 'POST', body: form });
      const data = await res.json() as { key?: string; name?: string; mime?: string; size?: number; error?: string };
      if (!res.ok || !data.key) {
        setPending((prev) => prev.map((p) => p.key === tempKey ? { ...p, uploading: false, error: data.error ?? 'Upload failed' } : p));
        return;
      }
      setPending((prev) => prev.map((p) =>
        p.key === tempKey ? { key: data.key!, name: data.name!, mime: data.mime!, size: data.size!, uploading: false } : p,
      ));
    } catch {
      setPending((prev) => prev.map((p) => p.key === tempKey ? { ...p, uploading: false, error: 'Upload failed' } : p));
    }
  }

  function handleFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      void uploadFile(file);
    }
  }

  // ── Post ────────────────────────────────────────────────────────────────────

  async function handlePost() {
    if (!compose.trim() && pending.filter((p) => !p.error && !p.uploading).length === 0) return;
    setPosting(true);
    try {
      const attachments = pending.filter((p) => !p.error && !p.uploading).map(({ key, name, mime, size }) => ({ key, name, mime, size }));
      const res  = await fetch(`/api/prospects/${prospectId}/updates`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ body: compose.trim() || '.', attachments }),
      });
      const data = await res.json() as { update?: ProspectUpdate };
      if (res.ok && data.update) {
        setUpdates((prev) => [data.update!, ...prev]);
        setCompose('');
        setFocused(false);
        setMentionQuery(null);
        setPending([]);
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

  function handleReacted(updateId: string, reactions: MessageReaction[]) {
    setUpdates((prev) => prev.map((u) => u.updateId === updateId ? { ...u, reactions } : u));
  }

  // ── Compose input ───────────────────────────────────────────────────────────

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
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionCursor((c) => Math.min(c + 1, mentionCandidates.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionCursor((c) => Math.max(c - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionCandidates[mentionCursor]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handlePost();
    }
  }

  // ── Drag-and-drop ───────────────────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) {
    if (readOnly) return;
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave() { setDragOver(false); }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (readOnly) return;
    if (e.dataTransfer.files.length) {
      setFocused(true);
      handleFiles(e.dataTransfer.files);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const canPost = !hasUploading && !posting && (compose.trim() || pending.some((p) => !p.error && !p.uploading));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {readOnly && (
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: '0 0 16px', fontStyle: 'italic' }}>
          This prospect has been promoted. No new updates can be added.
        </p>
      )}

      {!readOnly && (
        <div style={{ position: 'relative', marginBottom: 20 }}>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              border: `1px solid ${dragOver ? 'var(--accent)' : focused ? 'var(--accent)' : 'var(--color-border,#444)'}`,
              borderRadius: 8, overflow: 'visible',
              transition: 'border-color 150ms ease',
              background: dragOver ? 'rgba(var(--accent-rgb,99,102,241),0.05)' : undefined,
            }}
          >
            <textarea
              ref={textareaRef}
              value={compose}
              onChange={handleComposeChange}
              onFocus={() => setFocused(true)}
              onBlur={() => { if (!compose.trim() && pending.length === 0) setFocused(false); }}
              onKeyDown={handleKeyDown}
              placeholder="Add an update… (@name to mention, or drop a file)"
              disabled={posting}
              rows={focused || compose || pending.length > 0 ? 3 : 1}
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

            {/* Pending attachments row */}
            {pending.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 0.75rem 0.6rem' }}>
                {pending.map((p) => (
                  <PendingChip
                    key={p.key}
                    p={p}
                    onRemove={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
                  />
                ))}
              </div>
            )}

            {(focused || compose || pending.length > 0) && (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.4rem 0.65rem 0.5rem',
                borderTop: '1px solid var(--line)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Attach button */}
                  <button
                    type="button"
                    title="Attach file"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={posting}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--muted)', padding: 2, lineHeight: 1,
                      display: 'flex', alignItems: 'center',
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                    </svg>
                  </button>
                  {/* Task button — opens NewTaskModal pre-bound to this person.
                      Defaults to preprod for prospects per spec; for active/
                      inactive clients the modal renders its own taskType picker. */}
                  <button
                    type="button"
                    title={`Create task for ${companyName}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setShowNewTask(true)}
                    disabled={posting}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--muted)', padding: 2, lineHeight: 1,
                      display: 'flex', alignItems: 'center',
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 11 12 14 22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                  </button>
                  <span style={{ fontSize: '0.72rem', color: 'var(--muted-soft)' }}>
                    ⌘↵ to post · @name to mention
                  </span>
                </div>
                <button
                  type="button"
                  className="modal-btn-primary"
                  style={{ padding: '0.28rem 0.9rem', fontSize: '0.8rem' }}
                  onClick={handlePost}
                  disabled={!canPost}
                >
                  {posting ? 'Posting…' : hasUploading ? 'Uploading…' : 'Post'}
                </button>
              </div>
            )}
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files) { setFocused(true); handleFiles(e.target.files); e.target.value = ''; } }}
          />

          {/* Inline task-creation modal. clientNames is just this person's
              company — the modal pre-fills and locks the client picker, so it
              only needs the one entry to render the disabled select correctly. */}
          {showNewTask && (
            <NewTaskModal
              clientNames={[companyName]}
              users={allUsers}
              currentUserId={currentUserId}
              taskType={defaultTaskType}
              defaultClientName={companyName}
              lockedClient
              onCreated={() => setShowNewTask(false)}
              onClose={() => setShowNewTask(false)}
            />
          )}

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
            currentUserId={currentUserId}
            userNames={userNames}
            prospectId={prospectId}
            onEdited={handleEdited}
            onDeleted={handleDeleted}
            onReacted={handleReacted}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
}
