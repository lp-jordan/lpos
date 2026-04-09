'use client';

/**
 * MediaDetailPanel
 *
 * Slide-in right-side drawer for a selected MediaAsset.
 * Mirrors the ScriptEditorPanel pattern — always in DOM, shown/hidden via CSS.
 *
 * Sections:
 *   • Frame.io — review iframe OR upload button (if not yet uploaded)
 *   • Transcription — status badge, re-transcribe button
 *   • Cloudflare Stream — push button (UI only, wiring pending)
 *   • Metadata — editable name / description with PATCH save
 *   • File info — size, path, dates
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';
import {
  CLOUDFLARE_STREAM_STATUS_LABEL,
  FRAMEIO_STATUS_LABEL,
  LEADERPASS_STATUS_LABEL,
} from '@/lib/models/media-asset';
import type { FrameIOComment } from '@/lib/services/frameio';

type CommentRow = FrameIOComment & { canEdit?: boolean; fromFrame?: boolean };
import type { AssetShareLink } from '@/lib/store/asset-share-links-store';
import { VideoTheaterMode } from './VideoTheaterMode';

interface Props {
  asset:              MediaAsset | null;
  projectId:          string;
  onClose:            () => void;
  onUpdated:          () => void;
  onGoToTranscript?:  (jobId: string) => void;
}

function formatBytes(b: number | null): string {
  if (b === null) return '—';
  if (b < 1024)          return `${b} B`;
  if (b < 1024 ** 2)     return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)     return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
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

function summarizeError(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(0, 3).join('\n');
}

const VERSION_COLORS = [
  { bg: 'rgba(100,149,237,0.15)', color: '#6495ed' }, // v1 — cornflower blue
  { bg: 'rgba(155,122,204,0.15)', color: '#9b7acc' }, // v2 — soft purple
  { bg: 'rgba(74,184,193,0.15)',  color: '#4ab8c1' }, // v3 — teal
  { bg: 'rgba(219,175,95,0.16)',  color: '#dbaf5f' }, // v4 — gold
];

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.opus', '.wma']);
function isAudioFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

export function MediaDetailPanel({ asset, projectId, onClose, onUpdated, onGoToTranscript }: Readonly<Props>) {
  const open = asset !== null;
  const sidebarVideoRef = useRef<HTMLVideoElement>(null);
  const [showLeaderPassErrorDetails, setShowLeaderPassErrorDetails] = useState(false);
  const [theaterSrc,                 setTheaterSrc]                 = useState<string | null>(null);
  const [theaterSeekTarget,          setTheaterSeekTarget]          = useState<number | null>(null);
  const [moreInfoOpen,               setMoreInfoOpen]               = useState(false);
  const [fioDropdownOpen,            setFioDropdownOpen]            = useState(false);

  function openTheater(src: string) {
    const t = sidebarVideoRef.current?.currentTime ?? 0;
    sidebarVideoRef.current?.pause();
    setTheaterSrc(src);
    if (t > 0) setTheaterSeekTarget(t);
  }

  // ── Metadata edit ──────────────────────────────────────────────────────────
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [metaDirty, setMetaDirty]     = useState(false);
  const [metaSaving, setMetaSaving]   = useState(false);

  // Sync fields when asset changes
  useEffect(() => {
    if (!asset) return;
    setName(asset.name);
    setDescription(asset.description);
    setMetaDirty(false);
    setShareError(null);
    setShowLeaderPassErrorDetails(false);
  }, [asset]);

  // Reset per-asset state only when the selected asset changes (not on re-renders of the same asset)
  useEffect(() => {
    setExistingShareLinks([]);
  }, [asset?.assetId]);

  async function handleSaveMeta() {
    if (!asset || !metaDirty) return;
    setMetaSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim() || asset.originalFilename, description }),
      });
      if (res.ok) { setMetaDirty(false); onUpdated(); }
    } finally {
      setMetaSaving(false);
    }
  }

  // ── Frame.io ───────────────────────────────────────────────────────────────
  const [fioUploading, setFioUploading]       = useState(false);
  const [fioError, setFioError]               = useState<string | null>(null);
  const [copied, setCopied]                   = useState(false);
  const [shareGenerating, setShareGenerating]   = useState(false);
  const [shareError, setShareError]             = useState<string | null>(null);
  const [existingShareLinks, setExistingShareLinks] = useState<AssetShareLink[]>([]);
  const [deletingShareId,   setDeletingShareId]   = useState<string | null>(null);

  // Poll while uploading
  const pollFio = useCallback(async () => {
    if (!asset || asset.frameio.status !== 'uploading') return;
    try {
      const res  = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/frameio`);
      const data = await res.json() as { frameio?: { status: string } };
      if (data.frameio?.status !== 'uploading') {
        onUpdated();
      }
    } catch { /* ignore */ }
  }, [asset, projectId, onUpdated]);

  useEffect(() => {
    if (!asset || asset.frameio.status !== 'uploading') return;
    const id = setInterval(() => { void pollFio(); }, 3000);
    return () => clearInterval(id);
  }, [asset, pollFio]);

  const pollLeaderPass = useCallback(async () => {
    if (!asset) return;
    const active = asset.leaderpass.status === 'preparing'
      || asset.cloudflare.status === 'uploading'
      || asset.cloudflare.status === 'processing';
    if (!active) return;

    try {
      const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/leaderpass`);
      const data = await res.json() as { leaderpass?: { status?: string }; cloudflare?: { status?: string } };
      if (data.leaderpass?.status !== 'preparing'
        && data.cloudflare?.status !== 'uploading'
        && data.cloudflare?.status !== 'processing') {
        onUpdated();
      }
    } catch {
      // ignore polling errors
    }
  }, [asset, projectId, onUpdated]);

  useEffect(() => {
    if (!asset) return;
    const active = asset.leaderpass.status === 'preparing'
      || asset.cloudflare.status === 'uploading'
      || asset.cloudflare.status === 'processing';
    if (!active) return;
    const id = setInterval(() => { void pollLeaderPass(); }, 3000);
    return () => clearInterval(id);
  }, [asset, pollLeaderPass]);

  async function handleUploadToFrameIO() {
    if (!asset) return;
    setFioError(null);
    setFioUploading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/frameio`, { method: 'POST' });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setFioError(d.error ?? 'Failed to start upload');
        return;
      }
      onUpdated();
    } catch {
      setFioError('Network error — could not start upload');
    } finally {
      setFioUploading(false);
    }
  }

  const [lpPublishing, setLpPublishing] = useState(false);
  const [lpError, setLpError] = useState<string | null>(null);
  const [lpResetting, setLpResetting] = useState(false);

  async function handlePushToLeaderPass() {
    if (!asset) return;
    setLpError(null);
    setLpPublishing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/leaderpass`, { method: 'POST' });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setLpError(data.error ?? 'Failed to start LeaderPass publish');
        return;
      }
      onUpdated();
    } catch {
      setLpError('Network error — could not queue LeaderPass publish');
    } finally {
      setLpPublishing(false);
    }
  }

  async function handleResetLeaderPass() {
    if (!asset) return;
    setLpError(null);
    setLpResetting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/leaderpass`, { method: 'DELETE' });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setLpError(data.error ?? 'Failed to reset LeaderPass publish');
        return;
      }
      onUpdated();
    } catch {
      setLpError('Network error — could not reset LeaderPass publish');
    } finally {
      setLpResetting(false);
    }
  }

  function handleCopyLink(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const fetchShareLinks = useCallback(async (assetId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${assetId}/shares`);
      if (!res.ok) return;
      const data = await res.json() as { shares: AssetShareLink[] };
      setExistingShareLinks(data.shares);
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => {
    if (asset?.assetId) void fetchShareLinks(asset.assetId);
  }, [asset?.assetId, fetchShareLinks]);

  async function handleGenerateShareLink() {
    if (!asset) return;
    setShareGenerating(true);
    setShareError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/share`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ assetIds: [asset.assetId], name: `Review — ${asset.name}` }),
      });
      const data = await res.json() as { shareUrl?: string; shareId?: string; error?: string };
      if (!res.ok) { setShareError(data.error ?? 'Failed to generate share link'); return; }
      if (data.shareUrl && data.shareId) {
        const link: AssetShareLink = {
          shareId:   data.shareId,
          shareUrl:  data.shareUrl,
          name:      `Review — ${asset.name}`,
          createdAt: new Date().toISOString(),
        };
        setExistingShareLinks((prev) => [...prev.filter((l) => l.shareId !== data.shareId), link]);
      }
    } catch {
      setShareError('Network error — could not generate share link');
    } finally {
      setShareGenerating(false);
    }
  }

  async function handleDeleteShareLink(shareId: string) {
    if (!asset) return;
    setDeletingShareId(shareId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/shares?shareId=${encodeURIComponent(shareId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) setExistingShareLinks((prev) => prev.filter((l) => l.shareId !== shareId));
    } catch { /* ignore */ } finally {
      setDeletingShareId(null);
    }
  }

  // ── Comments ───────────────────────────────────────────────────────────────
  const [comments,          setComments]          = useState<CommentRow[]>([]);
  const [commentsLoading,   setCommentsLoading]   = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [editingCommentId,  setEditingCommentId]  = useState<string | null>(null);
  const [editText,          setEditText]          = useState('');
  const [replyingToId,      setReplyingToId]      = useState<string | null>(null);
  const [replyText,         setReplyText]         = useState('');
  const [replyPosting,      setReplyPosting]      = useState(false);

  const fetchComments = useCallback(async () => {
    if (!asset?.frameio.assetId) return;
    setCommentsLoading(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`);
      const data = await res.json() as { comments?: CommentRow[]; error?: string };
      if (data.comments) setComments(data.comments);
    } catch { /* ignore */ } finally {
      setCommentsLoading(false);
    }
  }, [asset?.assetId, asset?.frameio.assetId, projectId]);

  // Load comments when panel opens and asset has a Frame.io file ID
  useEffect(() => {
    if (asset?.frameio.assetId) {
      setComments([]);
      void fetchComments();
    } else {
      setComments([]);
    }
  }, [asset?.frameio.assetId, fetchComments]);

  // Poll for new comments every 30s while panel is open
  useEffect(() => {
    if (!asset?.frameio.assetId) return;
    const id = setInterval(() => { void fetchComments(); }, 30_000);
    return () => clearInterval(id);
  }, [asset?.frameio.assetId, fetchComments]);

  async function handleUpdateComment(commentId: string) {
    if (!asset || !editText.trim()) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ commentId, text: editText.trim() }),
        },
      );
      if (res.ok) {
        setComments(prev => prev.map(c => c.id === commentId ? { ...c, text: editText.trim() } : c));
        setEditingCommentId(null);
        setEditText('');
      }
    } catch { /* ignore */ }
  }

  async function handleDeleteComment(commentId: string) {
    if (!asset) return;
    setDeletingCommentId(commentId);
    try {
      await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`,
        {
          method:  'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ commentId }),
        },
      );
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch { /* ignore */ } finally {
      setDeletingCommentId(null);
    }
  }

  async function handlePostReply(parentId: string) {
    if (!asset || !replyText.trim()) return;
    setReplyPosting(true);
    try {
      const res  = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: replyText.trim(), parentId }),
        },
      );
      const data = await res.json() as { reply?: { id: string; text: string; authorName: string; authorAvatar: string | null; createdAt: string }; parentId?: string };
      if (res.ok && data.reply && data.parentId) {
        setComments(prev => prev.map(c =>
          c.id === data.parentId ? { ...c, replies: [...c.replies, data.reply!] } : c,
        ));
        setReplyingToId(null);
        setReplyText('');
      }
    } catch { /* ignore */ } finally {
      setReplyPosting(false);
    }
  }

  async function handleToggleComplete(commentId: string, completed: boolean) {
    if (!asset) return;
    // Optimistic update
    setComments(prev => prev.map(c => c.id === commentId ? { ...c, completed } : c));
    try {
      await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ commentId, completed }),
        },
      );
    } catch {
      // Revert on failure
      setComments(prev => prev.map(c => c.id === commentId ? { ...c, completed: !completed } : c));
    }
  }

  // ── Re-transcribe ──────────────────────────────────────────────────────────
  async function handleRetranscribe() {
    if (!asset) return;
    await fetch(`/api/projects/${projectId}/media/${asset.assetId}/retranscribe`, { method: 'POST' });
    onUpdated();
  }

  // ── Determine live frameio status (asset may be stale while polling) ───────
  const fioStatus  = asset?.frameio.status ?? 'none';
  const isUploading = fioStatus === 'uploading' || fioUploading;

  return (
    <>
      {theaterSrc && asset && (
        <VideoTheaterMode
          src={theaterSrc}
          assetId={asset.assetId}
          projectId={projectId}
          frameioAssetId={asset.frameio.assetId}
          comments={comments}
          seekTarget={theaterSeekTarget}
          onClose={() => setTheaterSrc(null)}
          onCommentPosted={(comment) => setComments(prev => [...prev, comment])}
          onCommentCompleted={(id, completed) =>
            setComments(prev => prev.map(c => c.id === id ? { ...c, completed } : c))
          }
          onReplyPosted={(reply, parentId) =>
            setComments(prev => prev.map(c =>
              c.id === parentId ? { ...c, replies: [...c.replies, reply] } : c,
            ))
          }
          onSeekHandled={() => setTheaterSeekTarget(null)}
        />
      )}

      {open && <div className="mad-backdrop" onClick={onClose} aria-hidden="true" />}

      <aside className={`mad-panel${open ? ' mad-panel--open' : ''}`} role="dialog" aria-label="Media asset detail">

        {asset && (
          <>
            {/* ── Header ── */}
            <div className="mad-header">
              <div className="mad-header-info">
                <div className="mad-header-title-row">
                  <span className="mad-header-title">{asset.name}</span>
                  {(() => {
                    const slot = VERSION_COLORS[(asset.frameio.version - 1) % VERSION_COLORS.length];
                    return (
                      <span className="ma-badge ma-badge--version" style={{ background: slot.bg, color: slot.color }}>
                        v{asset.frameio.version}
                      </span>
                    );
                  })()}
                  {asset.fileSize !== null && (
                    <span className="mad-header-meta-item">{formatBytes(asset.fileSize)}</span>
                  )}
                  {asset.duration !== null && asset.duration > 0 && (
                    <span className="mad-header-meta-item">{formatTimestamp(asset.duration)}</span>
                  )}
                </div>
                {asset.name !== asset.originalFilename && (
                  <span className="mad-header-filename">{asset.originalFilename}</span>
                )}
                {(asset.leaderpass.status === 'preparing' || asset.cloudflare.status === 'uploading' || asset.cloudflare.status === 'processing') && (
                  <div className="mad-uploading-row">
                    <span className="mad-spinner" aria-hidden="true" />
                    <span className="mad-uploading-label">
                      {asset.cloudflare.status === 'processing'
                        ? 'Cloudflare is processing the asset…'
                        : `Uploading to Cloudflare… ${asset.cloudflare.progress ? `${asset.cloudflare.progress}%` : ''}`.trim()}
                    </span>
                  </div>
                )}
                {asset.cloudflare.status !== 'none' && (
                  <div className="mad-info-grid">
                    <span className="mad-info-label">Cloudflare</span>
                    <span className="mad-info-value">{CLOUDFLARE_STREAM_STATUS_LABEL[asset.cloudflare.status]}</span>
                    <span className="mad-info-label">Stream UID</span>
                    <span className="mad-info-value mad-info-value--mono">{asset.cloudflare.uid ?? '—'}</span>
                    <span className="mad-info-label">Playback</span>
                    <span className="mad-info-value">
                      {asset.leaderpass.playbackUrl ? (
                        <a href={asset.leaderpass.playbackUrl} target="_blank" rel="noreferrer" className="mad-video-unavail-link">
                          Open Cloudflare preview ↗
                        </a>
                      ) : '—'}
                    </span>
                  </div>
                )}
                {asset.leaderpass.status === 'awaiting_platform' && (
                  <p className="mad-hint">
                    Cloudflare delivery is ready. LPOS has stored the prepared payload and is waiting for the LeaderPass platform API handoff.
                  </p>
                )}
                {asset.leaderpass.lastPreparedAt && (
                  <p className="mad-hint">Prepared {formatDate(asset.leaderpass.lastPreparedAt)}</p>
                )}
                {(lpError || asset.leaderpass.lastError || asset.cloudflare.lastError) && (() => {
                  const message = lpError ?? asset.leaderpass.lastError ?? asset.cloudflare.lastError ?? '';
                  const preview = summarizeError(message);
                  const truncated = preview !== message;

                  return (
                    <div className="mad-error-block">
                      <p className={`mad-error ${showLeaderPassErrorDetails ? 'mad-error--expanded' : 'mad-error--clamped'}`}>
                        {showLeaderPassErrorDetails ? message : preview}
                      </p>
                      {truncated && (
                        <button
                          type="button"
                          className="mad-error-toggle"
                          onClick={() => setShowLeaderPassErrorDetails((current) => !current)}
                        >
                          {showLeaderPassErrorDetails ? 'Show less' : 'Show full error'}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
              <button type="button" className="mad-close-btn" onClick={onClose} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="mad-body">

              {/* ── Video preview ──
                   1. Frame.io uploaded → LPOS proxies the CDN stream so the
                      browser never makes a cross-origin request to Frame.io.
                      Works from any machine on the LAN.
                   2. Not on Frame.io → fall back to local NAS stream (host only). ── */}
              {(() => {
                const audio = isAudioFile(asset.originalFilename ?? asset.name);
                if (asset.frameio.assetId) {
                  const src = `/api/projects/${projectId}/media/${asset.assetId}/frameio-stream`;
                  return audio ? (
                    <div className="mad-audio-wrap">
                      <svg className="mad-audio-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                      </svg>
                      <audio className="mad-audio-player" src={src} controls preload="metadata" key={asset.assetId} />
                    </div>
                  ) : (
                    <>
                      <div className="mad-video-wrap">
                        <video ref={sidebarVideoRef} key={asset.assetId} className="mad-video" src={src} controls preload="metadata" />
                      </div>
                      <div className="mad-video-theater-row">
                        <button type="button" className="mad-action-btn" onClick={() => openTheater(src)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
                          </svg>
                          Theater mode
                        </button>
                        {/* Frame.io logo + share-links dropdown */}
                        <div className="mad-fio-menu-wrap">
                          <button
                            type="button"
                            className={`mad-fio-menu-btn${fioDropdownOpen ? ' mad-fio-menu-btn--active' : ''}`}
                            onClick={() => setFioDropdownOpen(o => !o)}
                            aria-label="Frame.io options"
                            title="Frame.io"
                          >
                            frame.io
                          </button>
                          {fioDropdownOpen && (
                            <>
                              <div className="mad-fio-menu-backdrop" onClick={() => setFioDropdownOpen(false)} />
                              <div className="mad-fio-menu">
                                {(asset.frameio.playerUrl || asset.frameio.reviewLink) && (
                                  <a
                                    href={asset.frameio.playerUrl ?? asset.frameio.reviewLink!}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mad-fio-menu-item mad-fio-menu-item--link"
                                    onClick={() => setFioDropdownOpen(false)}
                                  >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                                      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                                    </svg>
                                    Open in Frame.io
                                  </a>
                                )}
                                <button
                                  type="button"
                                  className="mad-fio-menu-item"
                                  onClick={() => { void handleGenerateShareLink(); }}
                                  disabled={shareGenerating}
                                >
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                                  </svg>
                                  {shareGenerating ? 'Generating…' : 'New share link'}
                                </button>
                                {existingShareLinks.length > 0 && <div className="mad-fio-menu-divider" />}
                                {existingShareLinks.map((link) => (
                                  <div key={link.shareId} className="mad-fio-menu-share-row">
                                    <span className="mad-fio-menu-share-url">{link.shareUrl}</span>
                                    <button
                                      type="button"
                                      className="mad-fio-menu-share-btn"
                                      onClick={() => handleCopyLink(link.shareUrl)}
                                      title="Copy link"
                                    >
                                      {copied ? '✓' : (
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                        </svg>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      className="mad-fio-menu-share-btn mad-fio-menu-share-btn--danger"
                                      onClick={() => void handleDeleteShareLink(link.shareId)}
                                      disabled={deletingShareId === link.shareId}
                                      title="Delete share link"
                                      aria-label="Delete share link"
                                    >
                                      {deletingShareId === link.shareId ? '…' : (
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                                          <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                                        </svg>
                                      )}
                                    </button>
                                  </div>
                                ))}
                                {shareError && <p className="mad-fio-menu-error">{shareError}</p>}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  );
                }
                if (asset.filePath) {
                  const src = `/api/projects/${projectId}/media/${asset.assetId}/stream`;
                  return audio ? (
                    <div className="mad-audio-wrap">
                      <svg className="mad-audio-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                      </svg>
                      <audio className="mad-audio-player" src={src} controls preload="metadata" key={asset.assetId} />
                    </div>
                  ) : (
                    <>
                      <div className="mad-video-wrap">
                        <video ref={sidebarVideoRef} key={asset.assetId} className="mad-video" src={src} controls preload="metadata" />
                      </div>
                      <div className="mad-video-theater-row">
                        <button type="button" className="mad-action-btn" onClick={() => openTheater(src)}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
                          </svg>
                          Theater mode
                        </button>
                      </div>
                    </>
                  );
                }
                return null;
              })()}

              {/* ── Frame.io upload / error (only shown when actionable) ── */}
              {(fioStatus === 'none' || isUploading || fioError) && (
                <div className="mad-section">
                  {/* Upload button */}
                  {fioStatus === 'none' && !isUploading && (
                    <button
                      type="button"
                      className="mad-action-btn mad-action-btn--primary"
                      onClick={handleUploadToFrameIO}
                      disabled={!asset.filePath}
                      title={!asset.filePath ? 'No local file path — cannot upload' : undefined}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      Upload to Frame.io
                    </button>
                  )}

                  {/* Uploading state */}
                  {isUploading && (
                    <div className="mad-uploading-row">
                      <span className="mad-spinner" aria-hidden="true" />
                      <span className="mad-uploading-label">Uploading to Frame.io…</span>
                    </div>
                  )}

                  {/* Errors */}
                  {fioError && <p className="mad-error">{fioError}</p>}
                  {!fioError && asset.frameio.lastError && fioStatus === 'none' && (
                    <p className="mad-error">Last attempt failed: {asset.frameio.lastError}</p>
                  )}
                </div>
              )}

              {/* ── Frame.io Comments ── */}
              {asset.frameio.assetId && (
                <div className="mad-section mad-comments-section">
                  <div className="mad-section-head">
                    <span className="mad-section-title">Comments</span>
                    {comments.length > 0 && (
                      <span className="mad-comments-count">{comments.length}</span>
                    )}
                    <button
                      type="button"
                      className="mad-icon-btn"
                      onClick={() => void fetchComments()}
                      title="Refresh comments"
                      aria-label="Refresh comments"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                      </svg>
                    </button>
                  </div>

                  {commentsLoading && comments.length === 0 && (
                    <p className="mad-comments-empty">Loading…</p>
                  )}
                  {!commentsLoading && comments.length === 0 && (
                    <p className="mad-comments-empty">No comments yet.</p>
                  )}

                  {comments.length > 0 && (
                    <div className="mad-comments-list">
                      {comments.map((c) => (
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
                            {c.timestamp !== null && (() => {
                              const label = `${formatTimestamp(c.timestamp)}${c.duration ? ` → ${formatTimestamp(c.timestamp + c.duration)}` : ''}`;
                              return (
                                <button
                                  type="button"
                                  className="mad-comment-time mad-comment-time--seek"
                                  title="Open in theater at this timestamp"
                                  onClick={() => {
                                    setTheaterSeekTarget(c.timestamp);
                                    if (!theaterSrc) {
                                      const src = asset.frameio.assetId
                                        ? `/api/projects/${projectId}/media/${asset.assetId}/frameio-stream`
                                        : asset.filePath ?? null;
                                      if (src) setTheaterSrc(src);
                                    }
                                  }}
                                >
                                  {label}
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 3, opacity: 0.7 }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                </button>
                              );
                            })()}
                            <span className="mad-comment-date">{formatCommentDate(c.createdAt)}</span>
                            {/* Complete / cross-off toggle */}
                            <button
                              type="button"
                              className={`mad-comment-action mad-comment-check${c.completed ? ' mad-comment-check--done' : ''}`}
                              onClick={() => void handleToggleComplete(c.id, !c.completed)}
                              title={c.completed ? 'Mark incomplete' : 'Mark complete'}
                              aria-label={c.completed ? 'Mark incomplete' : 'Mark complete'}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            </button>
                            {c.canEdit && editingCommentId !== c.id && (
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
                            <button
                              type="button"
                              className="mad-comment-action mad-comment-action--danger"
                              onClick={() => void handleDeleteComment(c.id)}
                              disabled={deletingCommentId === c.id}
                              aria-label="Delete comment"
                              title="Delete comment"
                            >
                              {deletingCommentId === c.id ? '…' : (
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                                  <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                                </svg>
                              )}
                            </button>
                          </div>
                          {editingCommentId === c.id ? (
                            <div className="mad-comment-edit">
                              <textarea
                                className="mad-comment-edit-input"
                                value={editText}
                                onChange={e => setEditText(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleUpdateComment(c.id); }
                                  if (e.key === 'Escape') { setEditingCommentId(null); setEditText(''); }
                                }}
                                rows={2}
                                autoFocus
                              />
                              <div className="mad-comment-edit-footer">
                                <button type="button" className="mad-comment-trigger" onClick={() => { setEditingCommentId(null); setEditText(''); }}>Cancel</button>
                                <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void handleUpdateComment(c.id)} disabled={!editText.trim()}>Save  ⌘↵</button>
                              </div>
                            </div>
                          ) : (
                            <p className="mad-comment-text">{c.text}</p>
                          )}
                          {(c.replies.length > 0 || replyingToId === c.id) && (
                            <div className="mad-comment-replies">
                              {c.replies.map((r) => (
                                <div key={r.id} className="mad-comment-reply">
                                  <span className="mad-comment-author">{r.authorName || 'Frame.io'}</span>
                                  <span className="mad-comment-date">{formatCommentDate(r.createdAt)}</span>
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
                                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostReply(c.id); }
                                      if (e.key === 'Escape') { setReplyingToId(null); setReplyText(''); }
                                    }}
                                  />
                                  <div className="mad-reply-actions">
                                    <button type="button" className="mad-comment-trigger" onClick={() => { setReplyingToId(null); setReplyText(''); }}>Cancel</button>
                                    <button type="button" className="mad-action-btn mad-action-btn--primary" onClick={() => void handlePostReply(c.id)} disabled={replyPosting || !replyText.trim()}>
                                      {replyPosting ? '…' : 'Reply'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {replyingToId !== c.id && (
                            <button type="button" className="mad-comment-trigger mad-reply-btn" onClick={() => { setReplyingToId(c.id); setReplyText(''); }}>
                              Reply
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── More info (collapsed by default) ── */}
              <div className="mad-section mad-more-info-section">
                <button
                  type="button"
                  className="mad-more-info-toggle"
                  onClick={() => setMoreInfoOpen(o => !o)}
                  aria-expanded={moreInfoOpen}
                >
                  <span className="mad-section-title">More info</span>
                  <svg
                    className={`mad-more-info-chevron${moreInfoOpen ? ' mad-more-info-chevron--open' : ''}`}
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>

                {moreInfoOpen && (
                  <div className="mad-more-info-content">

                    {/* Transcription */}
                    <div className="mad-more-info-sub">
                      <div className="mad-section-head">
                        <span className="mad-section-title">Transcription</span>
                        <div className="mad-tx-status-group">
                          <span className={`mad-tx-badge mad-tx-badge--${asset.transcription.status}`}>
                            {{
                              none:       'Not Transcribed',
                              queued:     'Queued',
                              processing: 'Transcribing…',
                              done:       'Done',
                              failed:     'Failed',
                            }[asset.transcription.status]}
                          </span>
                          {asset.transcription.fromPriorVersion && asset.transcription.status !== 'none' && (
                            <span
                              className="mad-tx-version-pill"
                              title={`Transcription is from version ${asset.transcription.sourceVersionNumber ?? '?'} of this asset`}
                            >
                              v{asset.transcription.sourceVersionNumber ?? '?'}
                            </span>
                          )}
                        </div>
                      </div>
                      {asset.transcription.status === 'done' && asset.transcription.jobId && onGoToTranscript && (
                        <button
                          type="button"
                          className="mad-action-btn mad-action-btn--primary"
                          onClick={() => onGoToTranscript(asset.transcription.jobId!)}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                          </svg>
                          Go to Transcript
                        </button>
                      )}
                      {asset.transcription.status !== 'queued' && asset.transcription.status !== 'processing' && (
                        <button
                          type="button"
                          className="mad-action-btn"
                          onClick={handleRetranscribe}
                          disabled={!asset.filePath}
                          title={!asset.filePath ? 'No local file path' : undefined}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                          </svg>
                          {asset.transcription.status === 'done' ? 'Re-transcribe' : 'Start Transcription'}
                        </button>
                      )}
                      {asset.transcription.completedAt && (
                        <p className="mad-hint">Completed {formatDate(asset.transcription.completedAt)}</p>
                      )}
                    </div>

                    {/* Metadata */}
                    <div className="mad-more-info-sub">
                      <div className="mad-section-head">
                        <span className="mad-section-title">Metadata</span>
                        {metaDirty && (
                          <button
                            type="button"
                            className="mad-save-btn"
                            onClick={handleSaveMeta}
                            disabled={metaSaving}
                          >
                            {metaSaving ? 'Saving…' : 'Save'}
                          </button>
                        )}
                      </div>
                      <div className="mad-field">
                        <label className="mad-field-label">Display Name</label>
                        <input
                          className="mad-field-input"
                          type="text"
                          value={name}
                          onChange={(e) => { setName(e.target.value); setMetaDirty(true); }}
                        />
                      </div>
                      <div className="mad-field">
                        <label className="mad-field-label">Description</label>
                        <textarea
                          className="mad-field-textarea"
                          rows={3}
                          value={description}
                          onChange={(e) => { setDescription(e.target.value); setMetaDirty(true); }}
                          placeholder="Optional notes…"
                        />
                      </div>
                    </div>

                    {/* File Info */}
                    <div className="mad-more-info-sub">
                      <span className="mad-section-title">File Info</span>
                      <div className="mad-info-grid">
                        <span className="mad-info-label">Filename</span>
                        <span className="mad-info-value">{asset.originalFilename}</span>
                        <span className="mad-info-label">Size</span>
                        <span className="mad-info-value">{formatBytes(asset.fileSize)}</span>
                        <span className="mad-info-label">Registered</span>
                        <span className="mad-info-value">{formatDate(asset.registeredAt)}</span>
                        <span className="mad-info-label">Type</span>
                        <span className="mad-info-value">{asset.storageType}</span>
                        {asset.filePath && (
                          <>
                            <span className="mad-info-label">Path</span>
                            <span className="mad-info-value mad-info-value--mono">{asset.filePath}</span>
                          </>
                        )}
                      </div>
                    </div>

                  </div>
                )}
              </div>

            </div>
          </>
        )}
      </aside>
    </>
  );
}
