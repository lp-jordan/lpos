'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import type { FrameIOComment } from '@/lib/services/frameio';

interface Props {
  src:             string;
  assetId:         string;
  projectId:       string;
  frameioAssetId:  string | null;
  comments:        FrameIOComment[];
  onClose:         () => void;
  onCommentPosted: (comment: FrameIOComment) => void;
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
  src, assetId, projectId, frameioAssetId, comments, onClose, onCommentPosted,
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
  const [commentMode,     setCommentMode]    = useState(false);
  const [commentTime,     setCommentTime]    = useState(0);
  const [commentDuration, setCommentDuration] = useState<number | null>(null);
  const [commentText,     setCommentText]    = useState('');
  const [commentPosting,  setCommentPosting] = useState(false);
  const [commentError,    setCommentError]   = useState<string | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (!commentMode) scheduleHide();
  }, [commentMode, scheduleHide]);

  // Initial hide timer
  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [scheduleHide]);

  // Keep controls pinned while comment bar is active
  useEffect(() => {
    if (commentMode) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(true);
      setTimeout(() => commentInputRef.current?.focus(), 50);
    } else {
      scheduleHide();
    }
  }, [commentMode, scheduleHide]);

  // Keyboard: Esc exits or cancels comment, Space toggles play
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (commentMode) { setCommentMode(false); setCommentText(''); setCommentDuration(null); }
        else onClose();
        return;
      }
      if (e.key === ' ' && !commentMode && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        togglePlay();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentMode, onClose]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }

  // Click on video: enter comment mode (if Frame.io), otherwise play/pause
  function handleVideoClick() {
    if (!frameioAssetId) { togglePlay(); return; }
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setCommentTime(v.currentTime);
    setCommentDuration(null);
    setCommentText('');
    setCommentError(null);
    setCommentMode(true);
  }

  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    // In comment mode the scrub bar is reserved for drag-to-extend; don't seek
    if (commentMode) return;
    const el = scrubRef.current;
    const v  = videoRef.current;
    if (!el || !v || !duration) return;
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration;
  }

  // Drag the right edge of the pending range to set duration
  function handleDurationDragStart(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    function onMove(ev: MouseEvent) {
      const el = scrubRef.current;
      if (!el || !duration) return;
      const rect    = el.getBoundingClientRect();
      const frac    = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const endTime = frac * duration;
      const raw     = endTime - commentTime;
      // Snap back to point comment if dragged left of start or too short
      setCommentDuration(raw >= 0.5 ? raw : null);
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function seekTo(ts: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ts;
    void v.play();
    setCommentMode(false);
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
            ...(commentDuration !== null ? { duration: Math.round(commentDuration) } : {}),
          }),
        },
      );
      const data = await res.json() as { comment?: FrameIOComment; error?: string };
      if (!res.ok) { setCommentError(data.error ?? 'Failed to post'); return; }
      if (data.comment) {
        onCommentPosted(data.comment);
        setCommentMode(false);
        setCommentText('');
        setCommentDuration(null);
      }
    } catch {
      setCommentError('Network error');
    } finally {
      setCommentPosting(false);
    }
  }

  const timedComments = comments.filter(c => c.timestamp !== null);

  // Pending range geometry (% of track width)
  const pendingLeft  = duration > 0 ? (commentTime / duration) * 100 : 0;
  const pendingWidth = duration > 0 && commentDuration !== null
    ? (commentDuration / duration) * 100
    : 0;

  return (
    <div
      className="vt-backdrop"
      onMouseMove={showControls}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="vt-container">

        {/* Video — click anywhere on the frame to drop a timed comment */}
        <div
          className={`vt-video-area${frameioAssetId ? ' vt-video-area--commentable' : ''}`}
          onClick={handleVideoClick}
        >
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
          {/* One-shot hint — fades in then out, never repeats until remount */}
          {frameioAssetId && !commentMode && (
            <div className="vt-click-hint">Click anywhere to leave a timed comment</div>
          )}
        </div>

        {/* Scrub + controls — auto-hides after 3 s of no movement */}
        <div className={`vt-bottom${controlsVisible ? ' vt-bottom--visible' : ''}`}>

          {/* Scrub bar with Frame.io comment markers */}
          <div className="vt-scrub-wrap" ref={scrubRef} onClick={handleScrubClick}>
            <div className="vt-scrub-track">
              <div
                className="vt-scrub-fill"
                style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
              />

              {/* Existing comments — range bar or tick */}
              {duration > 0 && timedComments.map(c => {
                const label = `${fmt(c.timestamp ?? 0)}${c.duration ? ` → ${fmt((c.timestamp ?? 0) + c.duration)}` : ''} — ${c.authorName}: ${c.text} (${fmtCreatedAt(c.createdAt)})`;
                if (c.duration && c.duration > 0) {
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="vt-scrub-range"
                      style={{
                        left:  `${((c.timestamp ?? 0) / duration) * 100}%`,
                        width: `${(c.duration / duration) * 100}%`,
                      }}
                      title={label}
                      onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                      aria-label={`Jump to comment at ${fmt(c.timestamp ?? 0)}`}
                    />
                  );
                }
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="vt-scrub-tick"
                    style={{ left: `${((c.timestamp ?? 0) / duration) * 100}%` }}
                    title={label}
                    onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                    aria-label={`Jump to comment at ${fmt(c.timestamp ?? 0)}`}
                  />
                );
              })}

              {/* Pending range — shown while composing a comment */}
              {commentMode && duration > 0 && (
                <div
                  className="vt-scrub-pending"
                  style={{ left: `${pendingLeft}%`, width: pendingWidth > 0 ? `${pendingWidth}%` : undefined }}
                >
                  {/* Drag handle at the right edge — grab to extend the range */}
                  <div
                    className="vt-scrub-drag-handle"
                    onMouseDown={handleDurationDragStart}
                    title="Drag to set range end"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Controls row / comment bar — share the same horizontal slot */}
          {commentMode ? (
            <div className="vt-comment-bar">
              <span className="vt-comment-ts">
                @ {fmt(commentTime)}
                {commentDuration !== null && (
                  <> → {fmt(commentTime + commentDuration)}</>
                )}
              </span>
              <input
                ref={commentInputRef}
                className="vt-comment-input"
                placeholder="Add a timed comment…"
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostComment(); }
                  if (e.key === 'Escape') { setCommentMode(false); setCommentText(''); setCommentDuration(null); }
                }}
              />
              {commentError && <span className="vt-comment-err">{commentError}</span>}
              <button
                type="button"
                className="vt-ctrl-btn"
                onClick={() => { setCommentMode(false); setCommentText(''); setCommentDuration(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="vt-ctrl-btn vt-ctrl-btn--post"
                onClick={() => void handlePostComment()}
                disabled={commentPosting || !commentText.trim()}
              >
                {commentPosting ? '…' : 'Post to Frame.io'}
              </button>
            </div>
          ) : (
            <div className="vt-controls">
              <button
                type="button"
                className="vt-ctrl-btn"
                onClick={e => { e.stopPropagation(); togglePlay(); }}
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                )}
              </button>
              <span className="vt-time">{fmt(currentTime)} / {fmt(duration)}</span>
              <div className="vt-spacer" />
              {timedComments.length > 0 && (
                <span className="vt-tick-count">
                  {timedComments.length} note{timedComments.length !== 1 ? 's' : ''}
                </span>
              )}
              <button
                type="button"
                className="vt-ctrl-btn"
                onClick={e => {
                  e.stopPropagation();
                  if (videoRef.current) { videoRef.current.muted = !muted; setMuted(m => !m); }
                }}
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="vt-ctrl-btn"
                onClick={e => { e.stopPropagation(); onClose(); }}
                aria-label="Exit theater"
                title="Exit theater (Esc)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16v3a2 2 0 002 2h3"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
