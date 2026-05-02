'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { FrameIOComment, FrameIOCommentReply } from '@/lib/services/frameio';
import { formatTimecode } from '@/lib/utils/time';

interface Props {
  src:                  string;
  assetId:              string;
  projectId:            string;
  frameioAssetId:       string | null;
  comments:             FrameIOComment[];
  seekTarget?:          number | null;
  onClose:              () => void;
  onCommentPosted:      (comment: FrameIOComment) => void;
  onCommentCompleted?:  (commentId: string, completed: boolean) => void;
  onReplyPosted?:       (reply: FrameIOCommentReply, parentId: string) => void;
  onSeekHandled?:       () => void;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function fmtCreatedAt(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

export function VideoTheaterMode({
  src, assetId, projectId, frameioAssetId, comments,
  seekTarget, onClose, onCommentPosted, onCommentCompleted, onReplyPosted, onSeekHandled,
}: Readonly<Props>) {
  const videoRef        = useRef<HTMLVideoElement>(null);
  const scrubRef        = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const hideTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing,         setPlaying]        = useState(false);
  const [currentTime,     setCurrentTime]    = useState(0);
  const [duration,        setDuration]       = useState(0);
  const [muted,           setMuted]          = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [commentTime,     setCommentTime]    = useState(0);
  const [commentText,     setCommentText]    = useState('');
  const [commentPosting,  setCommentPosting] = useState(false);
  const [commentError,    setCommentError]   = useState<string | null>(null);
  const [panelOpen,       setPanelOpen]      = useState(!!frameioAssetId || comments.length > 0);
  const [togglingId,      setTogglingId]     = useState<string | null>(null);
  const [replyingToId,    setReplyingToId]   = useState<string | null>(null);
  const [replyText,       setReplyText]      = useState('');
  const [replyPosting,    setReplyPosting]   = useState(false);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [scheduleHide]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === ' ' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        togglePlay();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // External seek — fired from MediaDetailPanel when a comment is clicked
  useEffect(() => {
    if (seekTarget == null) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seekTarget;
    void v.play();
    onSeekHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTarget]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }

  function handleVideoClick() {
    togglePlay();
  }

  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = scrubRef.current;
    const v  = videoRef.current;
    if (!el || !v || !duration) return;
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration;
    // Resume playback after seek — without this the video shows the new frame
    // but stays paused/stalled if it was buffering when the user clicked.
    void v.play();
  }

  function seekTo(ts: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ts;
    void v.play();
  }

  async function handlePostComment() {
    if (!commentText.trim() || !frameioAssetId) return;
    setCommentPosting(true);
    setCommentError(null);
    try {
      const res  = await fetch(
        `/api/projects/${projectId}/media/${assetId}/frameio/comments`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text:      commentText.trim(),
            timestamp: commentTime,
          }),
        },
      );
      const data = await res.json() as { comment?: FrameIOComment; error?: string };
      if (!res.ok) { setCommentError(data.error ?? 'Failed to post'); return; }
      if (data.comment) {
        onCommentPosted(data.comment);
        setCommentText('');
        setCommentError(null);
      }
    } catch {
      setCommentError('Network error');
    } finally {
      setCommentPosting(false);
    }
  }

  async function handleToggleComplete(commentId: string, completed: boolean) {
    setTogglingId(commentId);
    try {
      await fetch(
        `/api/projects/${projectId}/media/${assetId}/frameio/comments`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ commentId, completed }),
        },
      );
      onCommentCompleted?.(commentId, completed);
    } catch { /* ignore */ } finally {
      setTogglingId(null);
    }
  }

  async function handlePostReply(parentId: string) {
    if (!replyText.trim()) return;
    setReplyPosting(true);
    try {
      const res  = await fetch(
        `/api/projects/${projectId}/media/${assetId}/frameio/comments`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: replyText.trim(), parentId }),
        },
      );
      const data = await res.json() as { reply?: FrameIOCommentReply; parentId?: string };
      if (res.ok && data.reply && data.parentId) {
        onReplyPosted?.(data.reply, data.parentId);
        setReplyingToId(null);
        setReplyText('');
      }
    } catch { /* ignore */ } finally {
      setReplyPosting(false);
    }
  }

  const timedComments  = comments.filter(c => c.timestamp !== null);
  const sortedComments = [...comments].sort((a, b) => {
    if (a.timestamp !== null && b.timestamp !== null) return a.timestamp - b.timestamp;
    if (a.timestamp !== null) return -1;
    if (b.timestamp !== null) return 1;
    return 0;
  });

  return (
    <div
      className="vt-backdrop"
      onMouseMove={showControls}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Outer flex row: video stack + optional comment panel */}
      <div className={`vt-layout${panelOpen ? ' vt-layout--panel-open' : ''}`}>

        {/* ── Left: video + controls ── */}
        <div className="vt-container">
          <div className="vt-video-area" onClick={handleVideoClick}>
            <video
              ref={videoRef}
              className="vt-video"
              src={src}
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
              onLoadedMetadata={() => {
                setDuration(videoRef.current?.duration ?? 0);
                void videoRef.current?.play();
              }}
            />
          </div>

          <div className={`vt-bottom${controlsVisible ? ' vt-bottom--visible' : ''}`}>
            {/* Scrub bar */}
            <div className="vt-scrub-wrap" ref={scrubRef} onClick={handleScrubClick}>
              <div className="vt-scrub-track">
                <div
                  className="vt-scrub-fill"
                  style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
                />
                {duration > 0 && timedComments.map(c => {
                  const label = `${formatTimecode(c.timestamp ?? 0)}${c.duration ? ` → ${formatTimecode((c.timestamp ?? 0) + c.duration)}` : ''} — ${c.authorName || 'Frame.io'}: ${c.text}${fmtCreatedAt(c.createdAt) ? ` (${fmtCreatedAt(c.createdAt)})` : ''}`;
                  if (c.duration && c.duration > 0) {
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`vt-scrub-range${c.completed ? ' vt-scrub-range--done' : ''}`}
                        style={{
                          left:  `${((c.timestamp ?? 0) / duration) * 100}%`,
                          width: `${(c.duration / duration) * 100}%`,
                        }}
                        title={label}
                        onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                        aria-label={`Jump to comment at ${formatTimecode(c.timestamp ?? 0)}`}
                      />
                    );
                  }
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`vt-scrub-tick${c.completed ? ' vt-scrub-tick--done' : ''}`}
                      style={{ left: `${((c.timestamp ?? 0) / duration) * 100}%` }}
                      title={label}
                      onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                      aria-label={`Jump to comment at ${formatTimecode(c.timestamp ?? 0)}`}
                    />
                  );
                })}
              </div>
            </div>

            {/* Controls */}
            <div className="vt-controls">
              <button type="button" className="vt-ctrl-btn" onClick={e => { e.stopPropagation(); togglePlay(); }} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                )}
              </button>
              <span className="vt-time">{fmt(currentTime)} / {fmt(duration)}</span>
              <div className="vt-spacer" />
              {frameioAssetId && (
                <button
                  type="button"
                  className={`vt-ctrl-btn vt-notes-btn${panelOpen ? ' vt-notes-btn--active' : ''}`}
                  onClick={e => { e.stopPropagation(); setPanelOpen(o => !o); }}
                  title={panelOpen ? 'Hide comments' : 'Show comments'}
                >
                  {comments.length > 0 ? `${comments.length} comment${comments.length !== 1 ? 's' : ''}` : 'Comments'}
                </button>
              )}
              <button type="button" className="vt-ctrl-btn" onClick={e => { e.stopPropagation(); if (videoRef.current) { videoRef.current.muted = !muted; setMuted(m => !m); } }} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
                )}
              </button>
              <button type="button" className="vt-ctrl-btn" onClick={e => { e.stopPropagation(); onClose(); }} aria-label="Exit theater" title="Exit theater (Esc)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16v3a2 2 0 002 2h3"/></svg>
              </button>
            </div>
          </div>
        </div>

        {/* ── Right: comment panel (slides in/out) ── */}
        <aside className={`vt-comment-panel${panelOpen ? ' vt-comment-panel--open' : ''}`} aria-label="Comments">
          <div className="vt-cp-header">
            <span className="vt-cp-title">Comments</span>
            <button type="button" className="vt-ctrl-btn" onClick={() => setPanelOpen(false)} aria-label="Close comments">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="vt-cp-list">
            {sortedComments.map(c => (
              <div key={c.id} className={`vt-cp-comment${c.completed ? ' vt-cp-comment--done' : ''}`}>
                <div className="vt-cp-comment-top">
                  {c.timestamp !== null ? (
                    <button type="button" className="vt-cp-ts" onClick={() => seekTo(c.timestamp ?? 0)} title="Jump to this point">
                      {formatTimecode(c.timestamp)}{c.duration ? ` → ${formatTimecode(c.timestamp + c.duration)}` : ''}
                    </button>
                  ) : (
                    <span className="vt-cp-general">General</span>
                  )}
                  <span className="vt-cp-author">{c.authorName || 'Frame.io'}</span>
                  <button
                    type="button"
                    className={`vt-cp-check${c.completed ? ' vt-cp-check--done' : ''}`}
                    onClick={() => void handleToggleComplete(c.id, !c.completed)}
                    disabled={togglingId === c.id}
                    title={c.completed ? 'Mark incomplete' : 'Mark complete'}
                    aria-label={c.completed ? 'Mark incomplete' : 'Mark complete'}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                </div>
                <p className="vt-cp-text">{c.text}</p>
                {fmtCreatedAt(c.createdAt) && <span className="vt-cp-date">{fmtCreatedAt(c.createdAt)}</span>}

                {/* Replies */}
                {(c.replies ?? []).length > 0 && (
                  <div className="vt-cp-replies">
                    {(c.replies ?? []).map(r => (
                      <div key={r.id} className="vt-cp-reply">
                        <span className="vt-cp-reply-author">{r.authorName || 'Frame.io'}</span>
                        <p className="vt-cp-text">{r.text}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply input */}
                {replyingToId === c.id ? (
                  <div className="vt-cp-reply-compose">
                    <input
                      className="vt-cp-reply-input"
                      placeholder="Write a reply…"
                      value={replyText}
                      autoFocus
                      onChange={e => setReplyText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostReply(c.id); }
                        if (e.key === 'Escape') { setReplyingToId(null); setReplyText(''); }
                      }}
                    />
                    <div className="vt-cp-reply-actions">
                      <button type="button" className="vt-cp-reply-cancel" onClick={() => { setReplyingToId(null); setReplyText(''); }}>Cancel</button>
                      <button type="button" className="vt-cp-reply-send" onClick={() => void handlePostReply(c.id)} disabled={replyPosting || !replyText.trim()}>
                        {replyPosting ? '…' : 'Reply'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="vt-cp-reply-btn" onClick={() => { setReplyingToId(c.id); setReplyText(''); }}>
                    Reply
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* ── Compose footer ── */}
          {frameioAssetId && (
            <div className="vt-cp-compose">
              <div className="vt-cp-compose-ts">
                @ {formatTimecode(commentTime)}
              </div>
              <div className="vt-cp-compose-row">
                <input
                  ref={commentInputRef}
                  className="vt-cp-compose-input"
                  placeholder="Add a timed comment…"
                  value={commentText}
                  onFocus={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    // Round to nearest NDF frame boundary (real seconds → frame → NDF seconds)
                    setCommentTime(Math.round(v.currentTime * 24000 / 1001) / 24);
                    if (!v.paused) v.pause();
                  }}
                  onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostComment(); }
                    if (e.key === 'Escape') { setCommentText(''); setCommentError(null); (e.target as HTMLInputElement).blur(); }
                  }}
                />
                <button
                  type="button"
                  className="vt-cp-compose-send"
                  onClick={() => void handlePostComment()}
                  disabled={commentPosting || !commentText.trim()}
                  aria-label="Post comment"
                >
                  {commentPosting ? '…' : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  )}
                </button>
              </div>
              {commentError && <span className="vt-comment-err">{commentError}</span>}
            </div>
          )}
        </aside>

      </div>
    </div>
  );
}
