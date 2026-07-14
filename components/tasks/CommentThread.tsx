'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type {
  TaskComment,
  TaskCommentAttachment,
  HandoffCommentMetadata,
  HandoffAckCommentMetadata,
} from '@/lib/models/task-comment';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from '@/components/dashboard/MentionTextarea';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Link helpers ──────────────────────────────────────────────────────────────

const ROUTE_LABELS: Record<string, string> = {
  projects:   'Project',
  clients:    'Client',
  deliveries: 'Deliveries',
  dashboard:  'Dashboard',
  users:      'User',
  settings:   'Settings',
  activity:   'Activity',
  tasks:      'Tasks',
  platform:   'Platform',
};

// UUIDs and long hex/slug IDs — skip these when building friendly labels.
const ID_RE = /^[0-9a-f-]{8,}$|^[\w-]{20,}$/i;

function toLabel(seg: string): string {
  return ROUTE_LABELS[seg] ?? (seg[0].toUpperCase() + seg.slice(1).replace(/-/g, ' '));
}

function friendlyPathLabel(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (segs.length === 0) return 'Home';

  // /projects/clients/[clientName]/[projectId?]/[sub?]
  if (segs[0] === 'projects' && segs[1] === 'clients' && segs[2]) {
    const client = segs[2];
    // segs[3] is the projectId (UUID) — skip it; segs[4] is the sub-page
    const sub = segs[4] && !ID_RE.test(segs[4]) ? toLabel(segs[4]) : 'Project';
    return `${client}: ${sub}`;
  }

  // General case — walk back to the last human-readable segment
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!ID_RE.test(segs[i])) return toLabel(segs[i]);
  }
  return toLabel(segs[0]);
}

function getFriendlyLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const isInternal =
      typeof window !== 'undefined' && parsed.hostname === window.location.hostname;
    if (isInternal) return friendlyPathLabel(parsed.pathname);
    const domain = parsed.hostname.replace(/^www\./, '');
    const segs = parsed.pathname.split('/').filter(Boolean);
    const last = segs.at(-1) ?? '';
    if (!last || last.length > 24) return domain;
    return `${domain} · ${last.replace(/-/g, ' ')}`;
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}…` : url;
  }
}

// Module-level cache so the same URL isn't fetched more than once per session.
const labelCache = new Map<string, string>();

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function needsResolution(href: string): boolean {
  try {
    const u = new URL(href);
    return (
      typeof window !== 'undefined' &&
      u.hostname === window.location.hostname &&
      UUID_RE.test(u.pathname)
    );
  } catch { return false; }
}

function LinkToken({ href }: { href: string }) {
  const [label, setLabel] = useState<string>(() => labelCache.get(href) ?? getFriendlyLabel(href));
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

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="task-link" onClick={(e) => e.stopPropagation()}>
      {label}
    </a>
  );
}

function renderBody(text: string): React.ReactNode[] {
  const TOKEN_RE = /(@\w+)|(https?:\/\/[^\s<>'")\]]+)/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    if (match[1]) {
      nodes.push(
        <span key={match.index} className="task-mention">{match[1]}</span>,
      );
    } else {
      nodes.push(<LinkToken key={match.index} href={match[2]} />);
    }
    cursor = TOKEN_RE.lastIndex;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function UserAvatar({ user }: { user: UserSummary }) {
  const initials = user.name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return user.avatarUrl ? (
    <img className="comment-avatar" src={user.avatarUrl} alt={user.name} />
  ) : (
    <span className="comment-avatar comment-avatar--initials">{initials}</span>
  );
}

// ── Attachment display ────────────────────────────────────────────────────────

function AttachmentChip({ a }: { a: TaskCommentAttachment }) {
  const url     = `/api/attachment?key=${encodeURIComponent(a.key)}`;
  const isImage = a.mime.startsWith('image/');

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="comment-attachment-img-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={a.name} className="comment-attachment-img" />
      </a>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" download={a.name} className="comment-attachment-chip">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span className="comment-attachment-name">{a.name}</span>
    </a>
  );
}

// ── Pending upload chip ───────────────────────────────────────────────────────

interface PendingAttachment extends TaskCommentAttachment {
  uploading?: boolean;
  error?:     string;
}

function PendingChip({ p, onRemove }: { p: PendingAttachment; onRemove: () => void }) {
  return (
    <div className={`comment-pending-chip${p.error ? ' comment-pending-chip--error' : ''}${p.uploading ? ' comment-pending-chip--uploading' : ''}`}>
      <span className="comment-attachment-name">{p.uploading ? 'Uploading…' : p.error ? 'Failed' : p.name}</span>
      {!p.uploading && (
        <button type="button" onClick={onRemove} className="comment-pending-remove">✕</button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  taskId: string;
  currentUserId: string;
  users: UserSummary[];
}

export function CommentThread({ taskId, currentUserId, users }: Readonly<Props>) {
  const [comments,      setComments]      = useState<TaskComment[]>([]);
  const [body,          setBody]          = useState('');
  const [posting,       setPosting]       = useState(false);
  const [loading,       setLoading]       = useState(true);
  const [pending,       setPending]       = useState<PendingAttachment[]>([]);
  const [dragOver,      setDragOver]      = useState(false);
  const [editingId,     setEditingId]     = useState<string | null>(null);
  const [editBody,      setEditBody]      = useState('');
  const [savingEdit,    setSavingEdit]    = useState(false);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const hasUploading = pending.some((p) => p.uploading);

  // Build a set of handoff_ids that already have an acknowledgement comment in
  // this thread — so we can hide the "Acknowledge" button on handoff entries
  // that have already been acked. Cheap because we already iterate comments
  // for rendering; a Set lookup is O(1) per handoff entry.
  const ackedHandoffIds = useMemo(() => {
    const s = new Set<string>();
    for (const c of comments) {
      if (c.kind !== 'handoff_ack') continue;
      const meta = c.metadata as HandoffAckCommentMetadata | undefined;
      if (meta?.handoffId) s.add(meta.handoffId);
    }
    return s;
  }, [comments]);

  const acknowledgeHandoff = useCallback(async (handoffId: string) => {
    const res = await fetch(`/api/tasks/${taskId}/handoff/${handoffId}/acknowledge`, { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json() as { comment?: TaskComment };
    if (data.comment) setComments((prev) => [...prev, data.comment!]);
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    setComments([]);
    fetch(`/api/tasks/${taskId}/comments`)
      .then((r) => r.json())
      .then((d: { comments: TaskComment[] }) => setComments(d.comments))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [comments.length]);

  // ── Upload ────────────────────────────────────────────────────────────────

  async function uploadFile(file: File) {
    const tempKey = `pending-${Math.random()}`;
    const stub: PendingAttachment = { key: tempKey, name: file.name, mime: file.type, size: file.size, uploading: true };
    setPending((prev) => [...prev, stub]);

    const form = new FormData();
    form.append('file', file);

    try {
      const res  = await fetch(`/api/tasks/${taskId}/comments/attachments`, { method: 'POST', body: form });
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
    for (const file of Array.from(files)) void uploadFile(file);
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  const submit = useCallback(async () => {
    const readyAttachments = pending.filter((p) => !p.error && !p.uploading);
    if ((!body.trim() && readyAttachments.length === 0) || posting) return;
    setPosting(true);
    try {
      const attachments = readyAttachments.map(({ key, name, mime, size }) => ({ key, name, mime, size }));
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim() || '.', attachments }),
      });
      if (res.ok) {
        const data = await res.json() as { comment: TaskComment };
        setComments((prev) => [...prev, data.comment]);
        setBody('');
        setPending([]);
      }
    } finally {
      setPosting(false);
    }
  }, [body, posting, taskId, pending]);

  const deleteComment = useCallback(async (commentId: string) => {
    const res = await fetch(`/api/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
    if (res.ok) {
      setComments((prev) => prev.filter((c) => c.commentId !== commentId));
    }
  }, [taskId]);

  const startEdit = useCallback((c: TaskComment) => {
    setEditingId(c.commentId);
    setEditBody(c.body);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditBody('');
  }, []);

  const saveEdit = useCallback(async (commentId: string) => {
    if (!editBody.trim() || savingEdit) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editBody.trim() }),
      });
      if (res.ok) {
        const data = await res.json() as { comment: TaskComment };
        setComments((prev) => prev.map((c) => (c.commentId === commentId ? data.comment : c)));
        setEditingId(null);
        setEditBody('');
      }
    } finally {
      setSavingEdit(false);
    }
  }, [editBody, savingEdit, taskId]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }

  const canPost = !hasUploading && !posting && (body.trim() || pending.some((p) => !p.error && !p.uploading));

  return (
    <div className="comment-thread">
      <div className="comment-thread-label">Updates</div>

      <div className="comment-list">
        {loading && <div className="comment-loading">Loading…</div>}
        {!loading && comments.length === 0 && (
          <div className="comment-empty">No updates yet. Add the first comment.</div>
        )}
        {comments.map((c) => {
          const author = userMap.get(c.authorId);
          // Handoff entries render as a distinct callout, not the usual avatar+body
          // row, so they read as system events (chain-of-custody marker) rather
          // than ordinary chatter. handoff_ack will follow the same pattern in
          // Phase 4. The note itself is stored in `body`; metadata carries the
          // routing details (from → to).
          if (c.kind === 'handoff') {
            const meta = c.metadata as HandoffCommentMetadata | undefined;
            const fromName  = userMap.get(meta?.fromUserId ?? c.authorId)?.name ?? 'Someone';
            const toNames   = (meta?.toUserIds ?? [])
              .map((uid) => userMap.get(uid)?.name.split(' ')[0] ?? '…')
              .join(', ') || '—';
            const handoffId = meta?.handoffId ?? '';
            const isTargetAndNotMe =
              !!meta &&
              meta.toUserIds.includes(currentUserId) &&
              meta.fromUserId !== currentUserId;
            const alreadyAcked = handoffId ? ackedHandoffIds.has(handoffId) : true;
            const showAckButton = isTargetAndNotMe && !alreadyAcked;
            return (
              <div key={c.commentId} className="comment-item comment-item--handoff">
                <div className="handoff-entry">
                  <div className="handoff-entry-header">
                    <span className="handoff-entry-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14" />
                        <path d="M13 6l6 6-6 6" />
                      </svg>
                    </span>
                    <span className="handoff-entry-route">
                      <strong>{fromName}</strong> handed off to <strong>{toNames}</strong>
                    </span>
                    <span className="comment-time">{relativeTime(c.createdAt)}</span>
                  </div>
                  {c.body && c.body !== '.' && (
                    <div className="handoff-entry-note">{renderBody(c.body)}</div>
                  )}
                  {showAckButton && (
                    <div className="handoff-entry-actions">
                      <button
                        type="button"
                        className="handoff-ack-btn"
                        onClick={() => void acknowledgeHandoff(handoffId)}
                        title="Acknowledge — tells the handoff-er you saw it. Doesn't complete the handoff."
                      >
                        Acknowledge
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          }
          if (c.kind === 'handoff_ack') {
            const author = userMap.get(c.authorId);
            return (
              <div key={c.commentId} className="comment-item comment-item--handoff-ack">
                <div className="handoff-ack-entry">
                  <span className="handoff-ack-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span><strong>{author?.name.split(' ')[0] ?? 'Someone'}</strong> acknowledged the handoff</span>
                  <span className="comment-time">{relativeTime(c.createdAt)}</span>
                </div>
              </div>
            );
          }
          if (c.kind === 'review_ack') {
            const author = userMap.get(c.authorId);
            return (
              <div key={c.commentId} className="comment-item comment-item--handoff-ack">
                <div className="handoff-ack-entry">
                  <span className="handoff-ack-icon" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span><strong>{author?.name.split(' ')[0] ?? 'Someone'}</strong> acknowledged the review check-in</span>
                  <span className="comment-time">{relativeTime(c.createdAt)}</span>
                </div>
              </div>
            );
          }
          return (
            <div key={c.commentId} className="comment-item">
              <div className="comment-author-col">
                {author ? <UserAvatar user={author} /> : <span className="comment-avatar comment-avatar--initials">?</span>}
              </div>
              <div className="comment-body-col">
                <div className="comment-meta">
                  <span className="comment-author-name">{author?.name ?? 'Unknown'}</span>
                  <span className="comment-time">{relativeTime(c.createdAt)}</span>
                  {c.editedAt && <span className="comment-time">(edited)</span>}
                  {c.authorId === currentUserId && c.kind === 'comment' && editingId !== c.commentId && (
                    <>
                      <button
                        type="button"
                        className="comment-edit-btn"
                        onClick={() => startEdit(c)}
                        title="Edit comment"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="comment-delete-btn"
                        onClick={() => void deleteComment(c.commentId)}
                        title="Delete comment"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
                {editingId === c.commentId ? (
                  <div className="comment-edit-area">
                    <MentionTextarea
                      value={editBody}
                      onChange={setEditBody}
                      users={users}
                      placeholder="Edit your update…"
                      rows={2}
                    />
                    <div className="comment-edit-actions">
                      <button
                        type="button"
                        className="comment-post-btn"
                        onClick={() => void saveEdit(c.commentId)}
                        disabled={!editBody.trim() || savingEdit}
                      >
                        {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="comment-edit-cancel"
                        onClick={cancelEdit}
                        disabled={savingEdit}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="comment-body">{renderBody(c.body)}</div>
                )}
                {c.attachments.length > 0 && (
                  <div className="comment-attachments">
                    {c.attachments.map((a) => <AttachmentChip key={a.key} a={a} />)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div
        className={`comment-input-area${dragOver ? ' comment-input-area--drag' : ''}`}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <MentionTextarea
          value={body}
          onChange={setBody}
          users={users}
          placeholder="Write an update… @mention a teammate  ·  Ctrl+Enter to post"
          rows={2}
        />

        {/* Pending attachments */}
        {pending.length > 0 && (
          <div className="comment-pending-row">
            {pending.map((p) => (
              <PendingChip
                key={p.key}
                p={p}
                onRemove={() => setPending((prev) => prev.filter((x) => x.key !== p.key))}
              />
            ))}
          </div>
        )}

        <div className="comment-input-footer">
          <button
            type="button"
            className="comment-attach-btn"
            title="Attach file"
            onClick={() => fileInputRef.current?.click()}
            disabled={posting}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <button
            type="button"
            className="comment-post-btn"
            onClick={() => void submit()}
            disabled={!canPost}
          >
            {posting ? 'Posting…' : hasUploading ? 'Uploading…' : 'Post'}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files) { handleFiles(e.target.files); e.target.value = ''; } }}
        />
      </div>
    </div>
  );
}
