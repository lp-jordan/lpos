'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { FrameIOComment, FrameIOCommentReply } from '@/lib/services/frameio';
import { formatTimecode } from '@/lib/utils/time';
import { useHlsPlayer } from '@/hooks/useHlsPlayer';

// ── Types ─────────────────────────────────────────────────────────────────────

// Comments arrive from the parent already enriched with the server-computed
// `canEdit` flag (true only for the current user's own top-level comments) and
// the `mirrorAbandoned` marker. Widen the base Frame.io shape here so the
// theater panel can gate its edit affordance on the same flag the sidebar uses.
export type PlayerComment = FrameIOComment & { canEdit?: boolean; mirrorAbandoned?: boolean };

interface Props {
  variant:             'compact' | 'theater';
  src:                 string;
  assetId:             string;
  projectId:           string;
  frameioAssetId?:     string | null;
  comments?:           PlayerComment[];
  seekTarget?:         number | null;
  onSeekHandled?:      () => void;
  onTheaterOpen?:       (currentTime: number) => void;   // compact only
  onClose?:             (currentTime: number) => void;   // theater only
  onCurrentTimeChange?: (currentTime: number) => void;   // theater only — for parent to track time
  onCommentPosted?:    (c: FrameIOComment) => void;
  onCommentCompleted?: (id: string, completed: boolean) => void;
  onCommentEdited?:    (id: string, text: string) => void;
  onReplyPosted?:      (reply: FrameIOCommentReply, parentId: string) => void;
  // Theater-only: slot element outside mp-root to portal the panel into
  panelContainer?:     HTMLDivElement | null;
  onPanelOpenChange?:  (open: boolean) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SPEED_LEVELS  = [1, 1.25, 1.5, 2] as const;
const SPEED_LOCK_PX = 25;   // downward drag to lock speed
const SPEED_HOLD_MS = 200;  // press must exceed this to start a speed hold; shorter = tap (play/pause)

// Scrub thumbnails: prefetch a capped-interval grid (instant, coarse) then
// refine the exact frame on settle. N = clamp(ceil(duration/TARGET), FLOOR, CAP).
const THUMB_TARGET_S = 2.5;  // ideal seconds between grid thumbnails
const THUMB_GRID_CAP = 60;   // hard ceiling on prefetched count (bounds load)
const THUMB_GRID_MIN = 8;    // floor so short clips still get a few
const THUMB_SETTLE_MS = 150; // pause-on-a-spot before fetching the exact frame

/** MM:SS:FF timecode at 24 fps */
function fmtTc(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00:00';
  const m  = Math.floor(s / 60);
  const sc = Math.floor(s % 60);
  const fr = Math.floor((s % 1) * 24);
  return `${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

function fmtCreatedAt(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MediaPlayer({
  variant, src, assetId, projectId, frameioAssetId,
  comments = [], seekTarget, onSeekHandled,
  onTheaterOpen, onClose, onCurrentTimeChange, onCommentPosted, onCommentCompleted, onCommentEdited, onReplyPosted,
  panelContainer, onPanelOpenChange,
}: Readonly<Props>) {
  const isTheater = variant === 'theater';

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef        = useRef<HTMLVideoElement>(null);
  const scrubRef        = useRef<HTMLDivElement>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const hideTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedLevelRef   = useRef(0);
  const speedStartYRef  = useRef(0);
  const speedLockedRef  = useRef(false);
  const recoveryRef     = useRef(false);
  const draggingRef       = useRef(false);
  const wasPlayingRef     = useRef(false);
  const movedRef          = useRef(false);
  const speedGestureRef   = useRef(false);
  // Scrub-thumbnail prefetch grid (coarse, instant) + settle timer (exact refine)
  const gridTimesRef      = useRef<number[]>([]);
  const settleTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── State ─────────────────────────────────────────────────────────────────
  const [streamUrl,      setStreamUrl]     = useState(src);
  const [playing,        setPlaying]       = useState(false);
  const [currentTime,    setCurrentTime]   = useState(0);
  const [duration,       setDuration]      = useState(0);
  const [videoAspect,    setVideoAspect]   = useState<number | null>(null);
  const [scrubPreview,   setScrubPreview]  = useState<{ t: number; x: number } | null>(null);
  const [scrubExact,     setScrubExact]    = useState(false);
  const [buffered,       setBuffered]      = useState(0);
  const [muted,          setMuted]         = useState(false);
  const [volume,         setVolume]        = useState(1);
  const [volHover,       setVolHover]      = useState(false);
  const [speed,          setSpeed]         = useState(1);
  const [speedLocked,    setSpeedLocked]   = useState(false);
  const [speedHolding,   setSpeedHolding]  = useState(false);
  const [rightHover,     setRightHover]    = useState(false);
  const [ctrlsVisible,   setCtrlsVisible]  = useState(true);
  const [unavailable,    setUnavailable]   = useState(false);
  const [panelOpen,      setPanelOpen]     = useState(false);
  const [commentTime,    setCommentTime]   = useState(0);
  const [commentText,    setCommentText]   = useState('');
  const [commentPosting, setCommentPosting] = useState(false);
  const [commentError,   setCommentError]  = useState<string | null>(null);
  const [togglingId,     setTogglingId]    = useState<string | null>(null);
  const [replyingToId,   setReplyingToId]  = useState<string | null>(null);
  const [replyText,      setReplyText]     = useState('');
  const [replyPosting,   setReplyPosting]  = useState(false);
  const [editingId,      setEditingId]     = useState<string | null>(null);
  const [editText,       setEditText]      = useState('');
  const [editSaving,     setEditSaving]    = useState(false);

  // ── Stream URL ────────────────────────────────────────────────────────────
  useEffect(() => {
    setStreamUrl(src);
    setUnavailable(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setVideoAspect(null);
    gridTimesRef.current = [];   // new source → rebuild the thumbnail grid
  }, [src]);

  const quality = useHlsPlayer(videoRef, streamUrl);

  const thumbnailUrl = useCallback(
    (t: number) => `/api/projects/${projectId}/media/${assetId}/thumbnail?time=${Math.round(t)}`,
    [projectId, assetId],
  );

  // Prefetch a capped-interval thumbnail grid once duration is known. Probe one
  // first — if the asset has no CF thumbnails (404), skip the grid so we don't
  // fire dozens of wasted requests. The grid warms the browser cache for an
  // instant snap during scrub; the exact frame is fetched on settle.
  useEffect(() => {
    if (!duration || duration <= 0) return;
    const n = Math.max(THUMB_GRID_MIN, Math.min(THUMB_GRID_CAP, Math.ceil(duration / THUMB_TARGET_S)));
    const times = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * duration));
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (cancelled) return;
      gridTimesRef.current = times;
      for (const t of times) { const img = new Image(); img.src = thumbnailUrl(t); }
    };
    probe.onerror = () => { if (!cancelled) gridTimesRef.current = []; };
    probe.src = thumbnailUrl(times[Math.floor(n / 2)]);
    return () => { cancelled = true; };
  }, [duration, thumbnailUrl]);

  // ── Controls visibility ───────────────────────────────────────────────────
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setCtrlsVisible(false), 1000);
  }, []);

  const showControls = useCallback(() => {
    setCtrlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  function handleContainerMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    showControls();
    const el = containerRef.current;
    if (!el) return;
    // Only treat this as a right-half (speed-zone) hover when the pointer is
    // actually over the video surface. The comments panel is portaled out of
    // .mp-root but its mousemove still bubbles here, which otherwise keeps the
    // speed-zone darkening lit while the user is in the comments box.
    const overVideo = (e.target as HTMLElement).closest('.mp-video-area');
    const rect = el.getBoundingClientRect();
    setRightHover(!!overVideo && e.clientX > rect.left + rect.width * 0.5);
  }

  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [scheduleHide]);

  // Clear speed timers on unmount so a pending hold/escalation can't setState after teardown
  useEffect(() => () => {
    if (holdTimerRef.current)   clearTimeout(holdTimerRef.current);
    if (speedTimerRef.current)  clearInterval(speedTimerRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  const ctrlsShown = ctrlsVisible;

  // ── Keyboard shortcuts (theater only) ────────────────────────────────────
  useEffect(() => {
    if (!isTheater) return;
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') { onClose?.(videoRef.current?.currentTime ?? 0); return; }
      if (inInput) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === ' ')           { e.preventDefault(); v.paused ? void v.play() : v.pause(); }
      if (e.key === 'ArrowLeft')   { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 1 / 24); }
      if (e.key === 'ArrowRight')  { e.preventDefault(); v.currentTime = Math.min(duration, v.currentTime + 1 / 24); }
      if (e.key === 'j')           { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); }
      if (e.key === 'l')           { e.preventDefault(); v.currentTime = Math.min(duration, v.currentTime + 5); }
      if (e.key === 'k')           { e.preventDefault(); v.paused ? void v.play() : v.pause(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTheater, duration, onClose]);

  // ── External seek ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (seekTarget == null) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seekTarget;
    void v.play();
    onSeekHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTarget]);

  // ── URL-expiry recovery ───────────────────────────────────────────────────
  async function handleVideoError() {
    if (!src.includes('frameio-stream')) { setUnavailable(true); return; }
    if (recoveryRef.current) return;
    recoveryRef.current = true;
    const v         = videoRef.current;
    const savedTime = v?.currentTime ?? 0;
    const wasPlay   = v ? !v.paused && !v.ended : false;
    try {
      // Derive the raw-refetch URL from src so a version-scoped src (?version=)
      // recovers the same version, not the latest.
      const rawUrl = src.includes('?') ? `${src}&raw=1` : `${src}?raw=1`;
      const res  = await fetch(rawUrl);
      if (!res.ok) { setUnavailable(true); return; }
      const data = await res.json() as { url?: string };
      if (!data.url) { setUnavailable(true); return; }
      setStreamUrl(data.url);
      const restore = () => {
        const vid = videoRef.current;
        if (!vid) return;
        vid.currentTime = savedTime;
        if (wasPlay) void vid.play();
        vid.removeEventListener('loadedmetadata', restore);
      };
      videoRef.current?.addEventListener('loadedmetadata', restore);
    } catch {
      setUnavailable(true);
    } finally {
      setTimeout(() => { recoveryRef.current = false; }, 10_000);
    }
  }

  // ── Scrub bar ─────────────────────────────────────────────────────────────
  function scrubTimeFromX(clientX: number): number | null {
    const el = scrubRef.current;
    if (!el || !duration) return null;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  }

  const THUMB_HALF_W = 80; // half of 160px thumbnail

  function scrubPreviewX(clientX: number): number {
    const el = scrubRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(THUMB_HALF_W, Math.min(rect.width - THUMB_HALF_W, clientX - rect.left));
  }

  // Nearest prefetched grid timestamp (instant snap); falls back to t when there
  // is no grid (no CF thumbnails) so the exact path still tries.
  function nearestGridTime(t: number): number {
    const grid = gridTimesRef.current;
    if (grid.length === 0) return t;
    let best = grid[0], bestD = Math.abs(t - best);
    for (let i = 1; i < grid.length; i += 1) {
      const d = Math.abs(t - grid[i]);
      if (d < bestD) { bestD = d; best = grid[i]; }
    }
    return best;
  }

  // While dragging, show the nearest grid frame instantly; once the pointer
  // settles, fetch the exact frame for that timecode and swap it in.
  function scheduleSettle() {
    setScrubExact(false);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => setScrubExact(true), THUMB_SETTLE_MS);
  }

  function endScrubPreview() {
    setScrubPreview(null);
    setScrubExact(false);
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null; }
  }

  function handleScrubPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const v = videoRef.current;
    if (!v || !duration) return;
    if ((e.target as HTMLElement).classList.contains('mp-tick') ||
        (e.target as HTMLElement).classList.contains('mp-range')) return;
    e.stopPropagation();
    const t = scrubTimeFromX(e.clientX);
    if (t === null) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    draggingRef.current   = true;
    wasPlayingRef.current = !v.paused && !v.ended;
    movedRef.current      = false;
    v.currentTime = t;
    setCurrentTime(t);
    setScrubPreview({ t, x: scrubPreviewX(e.clientX) });
    scheduleSettle();
  }

  function handleScrubPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    // Self-heal a stranded pointer-capture: a genuine drag always has a button
    // held (buttons !== 0). If we get a move with no button pressed, the
    // matching pointer-up was missed (e.g. the theater overlay mounted between
    // our pointer-down and -up), leaving capture stuck so every cursor move
    // scrubs. Release and stop tracking instead of seeking.
    if (e.buttons === 0) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      draggingRef.current = false;
      endScrubPreview();
      return;
    }
    const v = videoRef.current;
    if (!v || !duration) return;
    const t = scrubTimeFromX(e.clientX);
    if (t === null) return;
    if (!movedRef.current) { movedRef.current = true; if (!v.paused) v.pause(); }
    v.currentTime = t;
    setCurrentTime(t);
    setScrubPreview({ t, x: scrubPreviewX(e.clientX) });
    scheduleSettle();
  }

  function endScrubDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    draggingRef.current = false;
    endScrubPreview();
    const v = videoRef.current;
    if (!v) return;
    if (!movedRef.current || wasPlayingRef.current) void v.play();
    movedRef.current = false;
  }

  function seekTo(ts: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ts;
    void v.play();
  }

  // ── Speed hold gesture ────────────────────────────────────────────────────
  // A press on the right half of the video is ambiguous: a quick tap means
  // play/pause, a sustained hold means speed control. We disambiguate by time —
  // the speed gesture only begins once the press outlives SPEED_HOLD_MS. A
  // release before then leaves speedGestureRef false, so the synthetic click
  // falls through to the video-area play/pause handler untouched.
  function beginSpeedHold() {
    holdTimerRef.current    = null;
    speedLockedRef.current  = false;
    speedLevelRef.current   = 1;
    speedGestureRef.current = true; // swallow the click that follows this gesture

    const firstSpeed = SPEED_LEVELS[1]; // 1.25×
    setSpeed(firstSpeed);
    setSpeedHolding(true);
    if (videoRef.current) videoRef.current.playbackRate = firstSpeed;

    if (speedTimerRef.current) clearInterval(speedTimerRef.current);
    // Escalate from 1.25→1.5→2× at 1.5s intervals while held
    speedTimerRef.current = setInterval(() => {
      speedLevelRef.current = Math.min(speedLevelRef.current + 1, SPEED_LEVELS.length - 1);
      const s = SPEED_LEVELS[speedLevelRef.current];
      setSpeed(s);
      if (videoRef.current) videoRef.current.playbackRate = s;
    }, 1500);
  }

  function handleContainerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = containerRef.current;
    if (!el) return;
    // Speed-hold is a video-surface gesture only. Start it solely when the press
    // lands on the video itself — never on the controls bar, comments icon, speed
    // badge, or the comments panel. (The panel is portaled out of .mp-root, but
    // its events still bubble here through React's tree, so a class blocklist
    // missed it; a positive .mp-video-area check is the robust guard.)
    if (!(e.target as HTMLElement).closest('.mp-video-area')) return;
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width * 0.5) return;

    speedStartYRef.current = e.clientY;
    // Arm the hold — don't touch playback rate yet. If released first, it's a tap.
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(beginSpeedHold, SPEED_HOLD_MS);
  }

  function handleContainerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!speedTimerRef.current && !speedLockedRef.current) return;
    if (!speedLockedRef.current && e.clientY - speedStartYRef.current > SPEED_LOCK_PX) {
      speedLockedRef.current = true;
      setSpeedLocked(true);
      // Stop escalating once locked — speed stays at whatever level it reached
      if (speedTimerRef.current) { clearInterval(speedTimerRef.current); speedTimerRef.current = null; }
    }
  }

  function handleContainerPointerUp() {
    // Released before the hold threshold → it was a tap, not a speed gesture.
    // Leave speedGestureRef false so the click toggles play/pause.
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      return;
    }
    if (!speedTimerRef.current) return;
    clearInterval(speedTimerRef.current);
    speedTimerRef.current = null;
    setSpeedHolding(false);
    if (!speedLockedRef.current) {
      setSpeed(1);
      setSpeedLocked(false);
      if (videoRef.current) videoRef.current.playbackRate = 1;
    }
  }

  function clearLockedSpeed() {
    setSpeed(1);
    setSpeedLocked(false);
    setSpeedHolding(false);
    speedLockedRef.current = false;
    if (videoRef.current) videoRef.current.playbackRate = 1;
  }

  // ── Volume ────────────────────────────────────────────────────────────────
  function handleVolumeChange(val: number) {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val;
    v.muted  = val === 0;
    setVolume(val);
    setMuted(val === 0);
  }

  function toggleMute() {
    const v = videoRef.current;
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    setMuted(next);
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────
  function toggleFullscreen() {
    if (!document.fullscreenElement) void containerRef.current?.requestFullscreen();
    else void document.exitFullscreen();
  }

  // ── Buffered range ────────────────────────────────────────────────────────
  function handleProgress() {
    const v = videoRef.current;
    if (!v || !v.buffered.length) return;
    setBuffered(v.buffered.end(v.buffered.length - 1));
  }

  // ── Comments (theater only) ───────────────────────────────────────────────
  async function handlePostComment() {
    if (!commentText.trim()) return;
    setCommentPosting(true); setCommentError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/media/${assetId}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: commentText.trim(), timestamp: commentTime }),
      });
      const data = await res.json() as { comment?: FrameIOComment; error?: string };
      if (!res.ok) { setCommentError(data.error ?? 'Failed to post'); return; }
      if (data.comment) { onCommentPosted?.(data.comment); setCommentText(''); setCommentError(null); }
    } catch { setCommentError('Network error'); }
    finally { setCommentPosting(false); }
  }

  async function handleToggleComplete(commentId: string, completed: boolean) {
    setTogglingId(commentId);
    try {
      await fetch(`/api/projects/${projectId}/media/${assetId}/comments`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, completed }),
      });
      onCommentCompleted?.(commentId, completed);
    } catch {} finally { setTogglingId(null); }
  }

  async function handleEditComment(commentId: string) {
    if (!editText.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${assetId}/comments`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, text: editText.trim() }),
      });
      if (res.ok) {
        onCommentEdited?.(commentId, editText.trim());
        setEditingId(null); setEditText('');
      }
    } catch {} finally { setEditSaving(false); }
  }

  async function handlePostReply(parentId: string) {
    if (!replyText.trim()) return;
    setReplyPosting(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/media/${assetId}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: replyText.trim(), parentId }),
      });
      const data = await res.json() as { reply?: FrameIOCommentReply; parentId?: string };
      if (res.ok && data.reply && data.parentId) {
        onReplyPosted?.(data.reply, data.parentId);
        setReplyingToId(null); setReplyText('');
      }
    } catch {} finally { setReplyPosting(false); }
  }

  const timedComments  = comments.filter(c => c.timestamp !== null);
  const sortedComments = [...comments].sort((a, b) => {
    if (a.timestamp !== null && b.timestamp !== null) return a.timestamp - b.timestamp;
    if (a.timestamp !== null) return -1;
    if (b.timestamp !== null) return 1;
    return 0;
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className={`mp-root mp-root--${variant}`}
      style={!isTheater && videoAspect ? { aspectRatio: String(videoAspect) } : undefined}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={() => setRightHover(false)}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
      onPointerCancel={handleContainerPointerUp}
    >
      {/* Theater: comments icon top-right */}
      {isTheater && (
        <button
          type="button"
          className={`mp-comments-icon-btn${panelOpen ? ' mp-comments-icon-btn--active' : ''}`}
          onClick={e => { e.stopPropagation(); const next = !panelOpen; setPanelOpen(next); onPanelOpenChange?.(next); }}
          aria-label="Toggle comments"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
          {comments.length > 0 && (
            <span className="mp-comments-icon-badge">{comments.length}</span>
          )}
        </button>
      )}

      {/* Video area */}
      <div
        className="mp-video-area"
        onClick={() => {
          if (speedGestureRef.current) { speedGestureRef.current = false; return; }
          const v = videoRef.current;
          if (v) v.paused ? void v.play() : v.pause();
        }}
      >
        <video
          key={assetId}
          ref={videoRef}
          className="mp-video"
          preload="metadata"
          onPlay={()  => setPlaying(true)}
          onPause={()  => setPlaying(false)}
          onTimeUpdate={() => { const t = videoRef.current?.currentTime ?? 0; setCurrentTime(t); onCurrentTimeChange?.(t); }}
          onProgress={handleProgress}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            setDuration(v?.duration ?? 0);
            const w = v?.videoWidth ?? 0;
            const h = v?.videoHeight ?? 0;
            if (w > 0 && h > 0) setVideoAspect(w / h);
            void v?.play();
          }}
          onResize={() => {
            const v = videoRef.current;
            const w = v?.videoWidth ?? 0;
            const h = v?.videoHeight ?? 0;
            if (w > 0 && h > 0) setVideoAspect(w / h);
          }}
          onError={() => void handleVideoError()}
        />
        {unavailable && (
          <div className="mp-error-overlay">
            <span className="mp-error-title">Check back shortly</span>
            <span className="mp-error-sub">This video is still processing.</span>
            {isTheater && (
              <button type="button" className="mp-error-retry" onClick={() => { setUnavailable(false); setStreamUrl(src + '?retry=' + Date.now()); }}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      {/* Speed locked badge */}
      {speedLocked && speed > 1 && (
        <button type="button" className="mp-speed-badge" onClick={e => { e.stopPropagation(); clearLockedSpeed(); }}>
          {speed}× — tap to clear
        </button>
      )}

      {/* Right-half speed zone: hover hint or active hold indicator */}
      {(rightHover || speedHolding) && !speedLocked && (
        <div className={`mp-speed-zone${speedHolding ? ' mp-speed-zone--holding' : ''}`} aria-hidden>
          {speedHolding ? (
            <>
              <span className="mp-speed-zone-rate">{speed}×</span>
              <div className="mp-lock-hint">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
                <span>↓ drag to lock</span>
              </div>
            </>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" opacity="0.6">
              <polygon points="13 19 22 12 13 5 13 19"/>
              <polygon points="2 19 11 12 2 5 2 19"/>
            </svg>
          )}
        </div>
      )}

      {/* Controls bar */}
      <div className={`mp-controls-bar${ctrlsShown ? ' mp-controls-bar--visible' : ''}`}>
        {/* Scrub bar */}
        <div
          ref={scrubRef}
          className="mp-scrub"
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
          onPointerUp={endScrubDrag}
          onPointerCancel={endScrubDrag}
          style={{ touchAction: 'none' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="mp-scrub-track">
            <div className="mp-scrub-buffered" style={{ width: duration ? `${(buffered / duration) * 100}%` : '0%' }} />
            <div className="mp-scrub-fill"     style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }} />
            <div className="mp-scrub-head"     style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0%' }} />
            {duration > 0 && timedComments.map(c => {
              const pct = ((c.timestamp ?? 0) / duration) * 100;
              const tip = `${formatTimecode(c.timestamp ?? 0)}${c.duration ? ` → ${formatTimecode((c.timestamp ?? 0) + c.duration)}` : ''} — ${c.authorName ?? 'Frame.io'}: ${c.text}`;
              if (c.duration && c.duration > 0) {
                return (
                  <button key={c.id} type="button"
                    className={`mp-range${c.completed ? ' mp-range--done' : ''}`}
                    style={{ left: `${pct}%`, width: `${(c.duration / duration) * 100}%` }}
                    title={tip}
                    onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                    aria-label={`Comment range at ${formatTimecode(c.timestamp ?? 0)}`}
                  />
                );
              }
              return (
                <button key={c.id} type="button"
                  className={`mp-tick${c.completed ? ' mp-tick--done' : ''}`}
                  style={{ left: `${pct}%` }}
                  title={tip}
                  onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                  aria-label={`Comment at ${formatTimecode(c.timestamp ?? 0)}`}
                />
              );
            })}
          </div>

          {/* Scrub thumbnail preview. While dragging, snap to the nearest
              prefetched grid frame (instant, from cache); on settle, show the
              exact frame for the timecode. Image hides itself on a 404 (no CF
              thumbnail), leaving just the timecode. */}
          {scrubPreview && (() => {
            const previewT = scrubExact ? scrubPreview.t : nearestGridTime(scrubPreview.t);
            return (
              <div className="mp-scrub-thumb-wrap" style={{ left: scrubPreview.x }} aria-hidden>
                {/* No key: keep one persistent <img> and just swap src, so the
                    browser holds the current frame until the next loads (no
                    blank on the grid→exact settle). Hides itself on a 404. */}
                <img
                  className="mp-scrub-thumb"
                  src={thumbnailUrl(previewT)}
                  alt=""
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                  onLoad={e => { e.currentTarget.style.display = 'block'; }}
                />
                <span className="mp-scrub-thumb-tc">{fmtTc(scrubPreview.t)}</span>
              </div>
            );
          })()}
        </div>

        {/* Button row */}
        <div className="mp-btn-row">
          {/* Play / pause */}
          <button
            type="button" className="mp-btn"
            onClick={e => { e.stopPropagation(); const v = videoRef.current; if (v) v.paused ? void v.play() : v.pause(); }}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            }
          </button>

          <div className="mp-spacer" />

          {/* Timecode — centered */}
          <div className="mp-timecode" aria-live="off">
            {fmtTc(currentTime)} / {fmtTc(duration)}
          </div>

          <div className="mp-spacer" />

          {/* Volume: icon + hover-reveal slider */}
          <div
            className={`mp-vol-wrap${volHover ? ' mp-vol-wrap--open' : ''}`}
            onMouseEnter={() => setVolHover(true)}
            onMouseLeave={() => setVolHover(false)}
          >
            <div className="mp-vol-slider-wrap" onClick={e => e.stopPropagation()}>
              <input
                type="range" min="0" max="1" step="0.02"
                value={muted ? 0 : volume}
                className="mp-vol-slider"
                style={{ background: (() => { const p = (muted ? 0 : volume) * 100; return p === 0 ? 'transparent' : `linear-gradient(to right, #fff ${p}%, rgba(255,255,255,0.25) ${p}% 100%)`; })() }}
                onChange={e => handleVolumeChange(parseFloat(e.target.value))}
                aria-label="Volume"
              />
            </div>
            <button
              type="button" className="mp-btn"
              onClick={e => { e.stopPropagation(); toggleMute(); }}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
              }
            </button>
          </div>

          {/* Quality: Auto ⇄ full resolution (hls.js sources with >1 rendition) */}
          {quality.hasLevels && (
            <button
              type="button"
              className={`mp-btn mp-quality${quality.mode === 'max' ? ' mp-quality--on' : ''}`}
              onClick={e => { e.stopPropagation(); quality.setMode(quality.mode === 'max' ? 'auto' : 'max'); }}
              aria-label={quality.mode === 'max' ? 'Quality: full resolution — tap for auto' : 'Quality: auto — tap for full resolution'}
              title={quality.mode === 'max' ? 'Full resolution — tap for Auto' : 'Auto quality — tap for full resolution from the start'}
            >
              {quality.mode === 'max' ? 'HD' : 'AUTO'}
            </button>
          )}

          {/* Fullscreen (theater) or Theater-launch (compact) */}
          {isTheater
            ? (
              <button type="button" className="mp-btn" onClick={e => { e.stopPropagation(); toggleFullscreen(); }} aria-label="Fullscreen">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
                </svg>
              </button>
            ) : (
              <button type="button" className="mp-btn" onClick={e => { e.stopPropagation(); const v = videoRef.current; v?.pause(); onTheaterOpen?.(v?.currentTime ?? 0); }} aria-label="Open in theater mode">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
                </svg>
              </button>
            )
          }
        </div>
      </div>

      {/* Comment panel (theater only) — portaled outside mp-root so it slides beside the video */}
      {isTheater && panelContainer && createPortal(
        <aside
          className="mp-panel mp-panel--docked"
          aria-label="Comments"
          onClick={e => e.stopPropagation()}
        >
          <div className="mp-panel-header">
            <span className="mp-panel-title">Comments</span>
            <button type="button" className="mp-btn" onClick={() => { setPanelOpen(false); onPanelOpenChange?.(false); }} aria-label="Close comments">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>

          <div className="mp-panel-list">
            {sortedComments.map(c => (
              <div key={c.id} className={`mp-comment${c.completed ? ' mp-comment--done' : ''}`}>
                <div className="mp-comment-top">
                  {c.timestamp !== null ? (
                    <button type="button" className="mp-comment-ts" onClick={() => seekTo(c.timestamp ?? 0)}>
                      {formatTimecode(c.timestamp)}{c.duration ? ` → ${formatTimecode(c.timestamp + c.duration)}` : ''}
                    </button>
                  ) : (
                    <span className="mp-comment-general">General</span>
                  )}
                  {c.authorAvatar
                    ? <img src={c.authorAvatar} alt="" className="mp-avatar" />
                    : <div className="mp-avatar mp-avatar--placeholder">{(c.authorName || '?')[0]}</div>
                  }
                  <span className="mp-comment-author">{c.authorName ?? 'Frame.io'}</span>
                  {(c as FrameIOComment & { mirrorAbandoned?: boolean }).mirrorAbandoned && (
                    <span className="mad-comment-mirror-warn" title="Couldn't sync to Frame.io" aria-label="Mirror failed">!</span>
                  )}
                  <button
                    type="button"
                    className={`mp-check${c.completed ? ' mp-check--done' : ''}`}
                    onClick={() => void handleToggleComplete(c.id, !c.completed)}
                    disabled={togglingId === c.id}
                    aria-label={c.completed ? 'Mark incomplete' : 'Mark complete'}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                  {c.canEdit && editingId !== c.id && (
                    <button
                      type="button"
                      className="mp-comment-edit-btn"
                      onClick={() => { setEditingId(c.id); setEditText(c.text); }}
                      aria-label="Edit comment"
                      title="Edit comment"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                  )}
                </div>
                {editingId === c.id ? (
                  <div className="mp-comment-edit">
                    <textarea
                      className="mp-comment-edit-input"
                      value={editText}
                      autoFocus
                      rows={2}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleEditComment(c.id); }
                        if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
                      }}
                    />
                    <div className="mp-comment-edit-actions">
                      <button type="button" className="mp-reply-cancel" onClick={() => { setEditingId(null); setEditText(''); }}>Cancel</button>
                      <button type="button" className="mp-reply-send" onClick={() => void handleEditComment(c.id)} disabled={editSaving || !editText.trim()}>
                        {editSaving ? '…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mp-comment-text">{c.text}</p>
                )}
                {fmtCreatedAt(c.createdAt) && <span className="mp-comment-date">{fmtCreatedAt(c.createdAt)}</span>}

                {(c.replies ?? []).length > 0 && (
                  <div className="mp-replies">
                    {(c.replies ?? []).map(r => (
                      <div key={r.id} className="mp-reply">
                        <div className="mp-reply-head">
                          {r.authorAvatar
                            ? <img src={r.authorAvatar} alt="" className="mp-avatar mp-avatar--sm" />
                            : <div className="mp-avatar mp-avatar--sm mp-avatar--placeholder">{(r.authorName || '?')[0]}</div>
                          }
                          <span className="mp-reply-author">{r.authorName ?? 'Frame.io'}</span>
                        </div>
                        <p className="mp-comment-text">{r.text}</p>
                      </div>
                    ))}
                  </div>
                )}

                {replyingToId === c.id ? (
                  <div className="mp-reply-compose">
                    <input
                      className="mp-reply-input"
                      placeholder="Write a reply…"
                      value={replyText}
                      autoFocus
                      onChange={e => setReplyText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostReply(c.id); }
                        if (e.key === 'Escape') { setReplyingToId(null); setReplyText(''); }
                      }}
                    />
                    <div className="mp-reply-actions">
                      <button type="button" className="mp-reply-cancel" onClick={() => { setReplyingToId(null); setReplyText(''); }}>Cancel</button>
                      <button type="button" className="mp-reply-send" onClick={() => void handlePostReply(c.id)} disabled={replyPosting || !replyText.trim()}>
                        {replyPosting ? '…' : 'Reply'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="mp-reply-btn" onClick={() => { setReplyingToId(c.id); setReplyText(''); }}>
                    Reply
                  </button>
                )}
              </div>
            ))}
          </div>

          {(
            <div className="mp-compose">
              <div className="mp-compose-ts">@ {formatTimecode(commentTime)}</div>
              <div className="mp-compose-row">
                <input
                  ref={commentInputRef}
                  className="mp-compose-input"
                  placeholder="Add a timed comment…"
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  onFocus={() => {
                    const v = videoRef.current;
                    if (v) {
                      v.pause();
                      // NDF frame snap at 24fps
                      setCommentTime(Math.round(v.currentTime * 24000 / 1001) / 24);
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostComment(); }
                  }}
                />
                <button
                  type="button" className="mp-compose-send"
                  onClick={() => void handlePostComment()}
                  disabled={commentPosting || !commentText.trim()}
                  aria-label="Post comment"
                >
                  {commentPosting ? '…' : '↑'}
                </button>
              </div>
              {commentError && <span className="mp-compose-error">{commentError}</span>}
            </div>
          )}
        </aside>,
        panelContainer,
      )}
    </div>
  );
}
