'use client';

/**
 * AssetComments — the one comment system, shared by the media detail panel and
 * the Share viewer.
 *
 *   useAssetComments()     state + reads/writes against the LPOS-owned
 *                          media_comments API (version-scoped, Frame.io optional)
 *   AssetCommentsSection   the comment thread UI (list, replies, edit, complete,
 *                          timed compose)
 *
 * Extracted verbatim from MediaDetailPanel so both surfaces behave identically.
 * The Share viewer narrows it with props: `audience: 'client'` hides staff-only
 * threads, `postVisibility: 'internal'` makes new comments staff-only (never
 * mirrored to Frame.io), `lockedVersionId` pins a delivered share to one cut,
 * and `readOnly` / `canModerate` gate the actions.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { io as ioClient } from 'socket.io-client';
import type { FrameIOComment } from '@/lib/services/frameio';
import { formatTimecode } from '@/lib/utils/time';

export type CommentRow = FrameIOComment & { canEdit?: boolean; fromFrame?: boolean; mirrorAbandoned?: boolean; internal?: boolean };

export interface VersionInfo {
  assetVersionId: string;
  versionNumber:  number;
  createdAt:      string;
  commentCount:   number;
  isLatest:       boolean;
}

export interface UseAssetCommentsOptions {
  projectId:       string;
  assetId:         string | null;
  frameioAssetId:  string | null;
  /** 'client' hides internal (staff-only) threads. Default shows everything. */
  audience?:       'client' | 'all';
  /** Visibility stamped on new top-level comments. */
  postVisibility?: 'internal' | null;
  /** Pin the thread to one version (delivered shares). Disables switching. */
  lockedVersionId?: string | null;
}

function formatCommentDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

export function useAssetComments({ projectId, assetId, frameioAssetId, audience = 'all', postVisibility = null, lockedVersionId = null }: UseAssetCommentsOptions) {
  const [comments,          setComments]          = useState<CommentRow[]>([]);
  const [commentsLoading,   setCommentsLoading]   = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);

  // Version cycler. The thread always opens on the latest version (or the
  // locked one). Comments are pinned to a specific asset_version_id (locked
  // §11 #1), so each version has its own list.
  const [versions,          setVersions]          = useState<VersionInfo[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // Holds an optimistic completed-toggle until a refetch confirms Frame.io has
  // caught up. The webhook echo (comment.completed) arrives a beat *after* our
  // PATCH resolves, and Frame.io's read API briefly lags its own webhook, so a
  // refetch in that window returns the pre-toggle value. We keep masking with
  // the optimistic value until a fetched comment's `completed` matches it —
  // only then is the write known to have propagated, so we drop the guard.
  const pendingTogglesRef = useRef<Map<string, boolean>>(new Map());

  const base = assetId ? `/api/projects/${projectId}/media/${assetId}/comments` : null;

  const fetchComments = useCallback(async () => {
    // Frame.io optional: comments load for any asset, not just Frame.io ones.
    if (!base) return;
    setCommentsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (selectedVersionId) qs.set('version', selectedVersionId);
      if (audience === 'client') qs.set('audience', 'client');
      const res  = await fetch(`${base}${qs.size ? `?${qs}` : ''}`);
      const data = await res.json() as { comments?: CommentRow[]; error?: string };
      if (data.comments) {
        const pending = pendingTogglesRef.current;
        setComments(data.comments.map(c => {
          const want = pending.get(c.id);
          if (want === undefined) return c;
          if (c.completed === want) {        // Frame.io caught up → stop masking
            pending.delete(c.id);
            return c;
          }
          return { ...c, completed: want };  // still lagging → keep our value
        }));
      }
    } catch { /* ignore */ } finally {
      setCommentsLoading(false);
    }
  }, [base, selectedVersionId, audience]);

  // Fetch the version list when the asset opens. Default the selected version
  // to the locked one, else the latest.
  const fetchVersions = useCallback(async () => {
    if (!assetId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${assetId}/versions`);
      const data = await res.json() as { versions?: VersionInfo[]; error?: string };
      if (data.versions) {
        setVersions(data.versions);
        // Only set selected on initial load — don't clobber a user pick when
        // a refresh-fired versions list comes back.
        setSelectedVersionId((prev) => prev ?? lockedVersionId ?? data.versions?.find((v) => v.isLatest)?.assetVersionId ?? null);
      }
    } catch { /* ignore */ }
  }, [assetId, projectId, lockedVersionId]);

  // Load comments + versions when the asset changes; reset the selected
  // version so the new asset opens on its latest (or locked) version.
  useEffect(() => {
    setComments([]);
    setSelectedVersionId(null);
    if (assetId) void fetchVersions();
    else setVersions([]);
  }, [assetId, fetchVersions]);

  useEffect(() => {
    if (assetId && selectedVersionId) void fetchComments();
  }, [assetId, selectedVersionId, fetchComments]);

  // Real-time comment refresh via Frame.io webhook → Socket.io push. The
  // server emits 'frameio:comments:refresh' whenever Frame.io fires any
  // comment event; re-fetch only when it's for the asset on screen.
  useEffect(() => {
    if (!assetId || !frameioAssetId) return;
    const socket = ioClient('/', { transports: ['websocket'] });
    socket.on('frameio:comments:refresh', (data: { projectId: string; assetId: string }) => {
      if (data.projectId === projectId && data.assetId === assetId) void fetchComments();
    });
    return () => { socket.disconnect(); };
  }, [assetId, frameioAssetId, projectId, fetchComments]);

  async function updateComment(commentId: string, text: string): Promise<boolean> {
    if (!base || !text.trim()) return false;
    try {
      const res = await fetch(base, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, text: text.trim() }),
      });
      if (res.ok) setComments(prev => prev.map(c => c.id === commentId ? { ...c, text: text.trim() } : c));
      return res.ok;
    } catch { return false; }
  }

  async function deleteComment(commentId: string) {
    if (!base) return;
    setDeletingCommentId(commentId);
    try {
      await fetch(base, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commentId }) });
      setComments(prev => prev.filter(c => c.id !== commentId));
    } catch { /* ignore */ } finally {
      setDeletingCommentId(null);
    }
  }

  async function postReply(parentId: string, text: string): Promise<boolean> {
    if (!base || !text.trim()) return false;
    try {
      const res  = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), parentId }),
      });
      const data = await res.json() as { reply?: CommentRow['replies'][number]; parentId?: string };
      if (res.ok && data.reply && data.parentId) {
        setComments(prev => prev.map(c => c.id === data.parentId ? { ...c, replies: [...(c.replies ?? []), data.reply!] } : c));
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /** Posts a top-level timed comment. Returns an error message, or null on success. */
  async function postComment(text: string, timestamp: number): Promise<string | null> {
    if (!base || !text.trim()) return null;
    try {
      const res  = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), timestamp, visibility: postVisibility }),
      });
      const data = await res.json() as { comment?: CommentRow; error?: string };
      if (!res.ok) return data.error ?? 'Failed to post';
      if (data.comment) setComments(prev => [...prev, data.comment!]);
      return null;
    } catch {
      return 'Network error';
    }
  }

  async function toggleComplete(commentId: string, completed: boolean) {
    if (!base) return;
    pendingTogglesRef.current.set(commentId, completed);
    setComments(prev => prev.map(c => c.id === commentId ? { ...c, completed } : c));
    try {
      const res = await fetch(base, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, completed }),
      });
      if (!res.ok) throw new Error('server error');
      // Leave the guard in place on success — fetchComments clears it once
      // Frame.io's read reflects the toggle.
    } catch {
      pendingTogglesRef.current.delete(commentId);
      setComments(prev => prev.map(c => c.id === commentId ? { ...c, completed: !completed } : c));
    }
  }

  const latestVersionId     = versions.find((v) => v.isLatest)?.assetVersionId ?? null;
  const selectedVersion     = versions.find((v) => v.assetVersionId === selectedVersionId) ?? null;
  const isViewingOldVersion = !!selectedVersionId && !!latestVersionId && selectedVersionId !== latestVersionId && selectedVersionId !== lockedVersionId;

  return {
    comments, setComments, commentsLoading, deletingCommentId, pendingTogglesRef,
    versions, selectedVersionId, setSelectedVersionId, latestVersionId, selectedVersion, isViewingOldVersion,
    fetchComments, updateComment, deleteComment, postReply, postComment, toggleComplete,
  };
}

export type AssetCommentsState = ReturnType<typeof useAssetComments>;

interface SectionProps {
  ac:                  AssetCommentsState;
  /** Seek the player this thread belongs to. */
  onSeek:              (seconds: number) => void;
  /** Current playhead, read when the compose box takes focus. */
  getCurrentTime:      () => number;
  /** Hide compose, reply and edit (e.g. a delivered share). */
  readOnly?:           boolean;
  /** Mark complete + delete anyone's comment. Authors can always delete their own. */
  canModerate?:        boolean;
  showVersionSelect?:  boolean;
  showInternalTag?:    boolean;
  composePlaceholder?: string;
}

export function AssetCommentsSection({
  ac, onSeek, getCurrentTime,
  readOnly = false, canModerate = true, showVersionSelect = true, showInternalTag = false,
  composePlaceholder = 'Add a timed comment…',
}: Readonly<SectionProps>) {
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editText,         setEditText]         = useState('');
  const [replyingToId,     setReplyingToId]     = useState<string | null>(null);
  const [replyText,        setReplyText]        = useState('');
  const [replyPosting,     setReplyPosting]     = useState(false);
  const [versionMenuOpen,  setVersionMenuOpen]  = useState(false);

  // Sidebar compose — focus snaps the timestamp to the nearest NDF frame
  // boundary (same math the theater compose uses); blur leaves it pinned so
  // the user can scrub elsewhere without losing their attached time.
  const [composeText,    setComposeText]    = useState('');
  const [composeTime,    setComposeTime]    = useState(0);
  const [composePosting, setComposePosting] = useState(false);
  const [composeError,   setComposeError]   = useState<string | null>(null);
  const composeInputRef = useRef<HTMLInputElement>(null);

  async function saveEdit(commentId: string) {
    if (await ac.updateComment(commentId, editText)) {
      setEditingCommentId(null);
      setEditText('');
    }
  }

  async function sendReply(parentId: string) {
    if (!replyText.trim()) return;
    setReplyPosting(true);
    if (await ac.postReply(parentId, replyText)) {
      setReplyingToId(null);
      setReplyText('');
    }
    setReplyPosting(false);
  }

  async function sendComment() {
    if (!composeText.trim()) return;
    setComposePosting(true);
    setComposeError(null);
    const err = await ac.postComment(composeText, composeTime);
    if (err) setComposeError(err);
    else setComposeText('');
    setComposePosting(false);
  }

  return (
      <div className="mad-section mad-comments-section">
        <div className="mad-section-head">
          <span className="mad-section-title">Comments</span>
          {ac.comments.length > 0 && (
            <span className="mad-comments-count">{ac.comments.length}</span>
          )}
          <span className="mad-head-spacer" />

          {/* Version selector — right-justified. Switching a version
               swaps both this comment thread AND the player (older
               versions play from Frame.io; latest plays from CF). */}
          {showVersionSelect && ac.versions.length > 1 && (
            <div className="mad-version-select">
              <button
                type="button"
                className={`mad-version-select-btn${ac.isViewingOldVersion ? ' mad-version-select-btn--old' : ' mad-version-select-btn--latest'}`}
                onClick={() => setVersionMenuOpen((o) => !o)}
                title={ac.isViewingOldVersion ? `Viewing v${ac.selectedVersion?.versionNumber} — switch version` : 'Latest version — switch version'}
                aria-haspopup="listbox"
                aria-expanded={versionMenuOpen}
              >
                v{ac.selectedVersion?.versionNumber ?? '?'}
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              {versionMenuOpen && (
                <>
                  <div className="mad-version-menu-backdrop" onClick={() => setVersionMenuOpen(false)} />
                  <div className="mad-version-menu" role="listbox">
                    {ac.versions.map((v) => (
                      <button
                        key={v.assetVersionId}
                        type="button"
                        role="option"
                        aria-selected={ac.selectedVersionId === v.assetVersionId}
                        className={`mad-version-menu-item${ac.selectedVersionId === v.assetVersionId ? ' is-active' : ''}`}
                        onClick={() => { ac.setSelectedVersionId(v.assetVersionId); setVersionMenuOpen(false); }}
                      >
                        <span>v{v.versionNumber}{v.isLatest ? ' · latest' : ''}</span>
                        {v.commentCount > 0 && <span className="mad-version-menu-count">{v.commentCount}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            className="mad-icon-btn"
            onClick={() => void ac.fetchComments()}
            title="Refresh comments"
            aria-label="Refresh comments"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>
        </div>

        {/* Viewing an older version → make it obvious + one-click back. */}
        {ac.isViewingOldVersion && (
          <div className="mad-version-banner">
            <span className="mad-version-banner-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Viewing v{ac.selectedVersion?.versionNumber} · Frame.io
            </span>
            <button
              type="button"
              className="mad-version-back"
              onClick={() => ac.latestVersionId && ac.setSelectedVersionId(ac.latestVersionId)}
            >
              Back to current
            </button>
          </div>
        )}

        {ac.commentsLoading && ac.comments.length === 0 && (
          <p className="mad-comments-empty">Loading…</p>
        )}
        {!ac.commentsLoading && ac.comments.length === 0 && (
          <p className="mad-comments-empty">No comments yet.</p>
        )}

        {ac.comments.length > 0 && (
          <div className="mad-comments-list">
            {ac.comments.map((c) => (
              <div key={c.id} className={`mad-comment${c.completed ? ' mad-comment--done' : ''}`}>
                <div className="mad-comment-header">
                  {c.authorAvatar
                    ? <img src={c.authorAvatar} alt="" className="mad-comment-avatar" />
                    : <div className="mad-comment-avatar mad-comment-avatar--placeholder">{(c.authorName || '?')[0]}</div>
                  }
                  <span className="mad-comment-author">
                    {c.authorName || (c.fromFrame ? 'Frame.io' : 'Unknown')}
                  </span>
                  {c.fromFrame && (
                    <span className="mad-comment-source" title="Left via Frame.io">Frame.io</span>
                  )}
                  {showInternalTag && c.internal && (
                    <span className="mad-comment-source mad-comment-source--internal" title="Staff only — never shown to clients">Internal</span>
                  )}
                  {c.mirrorAbandoned && (
                    <span
                      className="mad-comment-mirror-warn"
                      title="Couldn't sync to Frame.io — clients viewing the review link won't see this comment."
                      aria-label="Mirror to Frame.io failed"
                    >
                      !
                    </span>
                  )}
                  {/* Timecode + date collapse when the name needs the room: the
                      date wraps out of sight first, then the timecode (the
                      zero-width spacer lets the timecode wrap too). */}
                  <div className="mad-comment-meta">
                    <span className="mad-comment-meta-spacer" aria-hidden="true" />
                    {c.timestamp !== null && (() => {
                      const label = `${formatTimecode(c.timestamp)}${c.duration ? ` → ${formatTimecode(c.timestamp + c.duration)}` : ''}`;
                      return (
                        <button
                          type="button"
                          className="mad-comment-time mad-comment-time--seek"
                          title="Jump to this timestamp"
                          onClick={() => {
                            // Seek the sidebar player in place. Don't auto-open
                            // theater — let the user decide when to do that
                            // (avoids two players playing at once).
                            onSeek(c.timestamp!);
                          }}
                        >
                          {label}
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 3, opacity: 0.7 }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </button>
                      );
                    })()}
                    <span className="mad-comment-date">{formatCommentDate(c.createdAt)}</span>
                  </div>
                  {/* Complete / cross-off toggle */}
                  {canModerate && (
                    <button
                      type="button"
                      className={`mad-comment-action mad-comment-check${c.completed ? ' mad-comment-check--done' : ''}`}
                      onClick={() => void ac.toggleComplete(c.id, !c.completed)}
                      title={c.completed ? 'Mark incomplete' : 'Mark complete'}
                      aria-label={c.completed ? 'Mark incomplete' : 'Mark complete'}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </button>
                  )}
                  {!readOnly && c.canEdit && editingCommentId !== c.id && (
                    <button
                      type="button"
                      className="mad-comment-action"
                      onClick={() => { setEditingCommentId(c.id); setEditText(c.text); }}
                      aria-label="Edit comment"
                      title="Edit comment"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                  )}
                  {(canModerate || c.canEdit) && (
                    <button
                      type="button"
                      className="mad-comment-action mad-comment-action--danger"
                      onClick={() => void ac.deleteComment(c.id)}
                      disabled={ac.deletingCommentId === c.id}
                      aria-label="Delete comment"
                      title="Delete comment"
                    >
                      {ac.deletingCommentId === c.id ? '…' : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                          <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                        </svg>
                      )}
                    </button>
                  )}
                </div>
                {editingCommentId === c.id ? (
                  <div className="mad-comment-edit">
                    <textarea
                      className="mad-comment-edit-input"
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveEdit(c.id); }
                        if (e.key === 'Escape') { setEditingCommentId(null); setEditText(''); }
                      }}
                      rows={2}
                      autoFocus
                    />
                    <div className="mad-comment-edit-footer">
                      <button type="button" className="mad-comment-trigger" onClick={() => { setEditingCommentId(null); setEditText(''); }}>Cancel</button>
                      <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void saveEdit(c.id)} disabled={!editText.trim()}>Save  ⌘↵</button>
                    </div>
                  </div>
                ) : (
                  <p className="mad-comment-text">{c.text}</p>
                )}
                {((c.replies ?? []).length > 0 || replyingToId === c.id) && (
                  <div className="mad-comment-replies">
                    {(c.replies ?? []).map((r) => (
                      <div key={r.id} className="mad-comment-reply">
                        {/* Reuse the same flex header layout as top-level comments
                         * so the date sits right-justified via the existing
                         * `.mad-comment-date { margin-left: auto }` rule. Without
                         * this wrapper the spans rendered as bare inline siblings,
                         * gluing the date against the author name. */}
                        <div className="mad-comment-header">
                          {r.authorAvatar
                            ? <img src={r.authorAvatar} alt="" className="mad-comment-avatar" />
                            : <div className="mad-comment-avatar mad-comment-avatar--placeholder">{(r.authorName || '?')[0]}</div>
                          }
                          <span className="mad-comment-author">{r.authorName || 'Frame.io'}</span>
                          <span className="mad-comment-date">{formatCommentDate(r.createdAt)}</span>
                        </div>
                        <p className="mad-comment-text">{r.text}</p>
                      </div>
                    ))}
                    {replyingToId === c.id && (
                      <div className="mad-reply-compose">
                        <input
                          className="mad-reply-input"
                          placeholder="Write a reply…"
                          value={replyText}
                          autoFocus
                          onChange={e => setReplyText(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(c.id); }
                            if (e.key === 'Escape') { setReplyingToId(null); setReplyText(''); }
                          }}
                        />
                        <div className="mad-reply-actions">
                          <button type="button" className="mad-comment-trigger" onClick={() => { setReplyingToId(null); setReplyText(''); }}>Cancel</button>
                          <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void sendReply(c.id)} disabled={replyPosting || !replyText.trim()}>
                            {replyPosting ? '…' : 'Reply'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {!readOnly && replyingToId !== c.id && (
                  <button type="button" className="mad-comment-trigger mad-reply-btn" onClick={() => { setReplyingToId(c.id); setReplyText(''); }}>
                    Reply
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Sidebar compose footer ──
             Mirrors VideoTheaterMode's compose block. Focus pauses
             the sidebar video and snaps the attached timestamp to
             the nearest NDF frame boundary. Sits at the end of the
             comments section (NOT sticky) so it scrolls with the
             surrounding panel content. */}
        {!readOnly && (
          <div className="mad-comment-compose">
            <div className="mad-comment-compose-ts">
              @ {formatTimecode(composeTime)}
            </div>
            <div className="mad-comment-compose-row">
              <input
                ref={composeInputRef}
                className="mad-comment-compose-input"
                placeholder={composePlaceholder}
                value={composeText}
                onFocus={() => {
                  // currentTime now comes from the MediaPlayer (reported via
                  // onCurrentTimeChange → sidebarTimeRef). Round to the nearest
                  // NDF frame boundary (real seconds → frame → NDF seconds).
                  setComposeTime(Math.round(getCurrentTime() * 24000 / 1001) / 24);
                }}
                onChange={e => setComposeText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendComment(); }
                  if (e.key === 'Escape') { setComposeText(''); setComposeError(null); (e.target as HTMLInputElement).blur(); }
                }}
              />
              <button
                type="button"
                className="mad-comment-compose-send"
                onClick={() => void sendComment()}
                disabled={composePosting || !composeText.trim()}
                aria-label="Post comment"
              >
                {composePosting ? '…' : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                )}
              </button>
            </div>
            {composeError && <span className="mad-compose-err">{composeError}</span>}
          </div>
        )}
      </div>
  );
}
