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

function summarizeError(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(0, 3).join('\n');
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg', '.opus', '.wma']);
function isAudioFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

export function MediaDetailPanel({ asset, projectId, onClose, onUpdated, onGoToTranscript }: Readonly<Props>) {
  const open = asset !== null;
  const [showLeaderPassErrorDetails, setShowLeaderPassErrorDetails] = useState(false);

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
    setGeneratedShareUrl(null);
    setShareError(null);
    setShowLeaderPassErrorDetails(false);
  }, [asset]);

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
  const [shareGenerating, setShareGenerating] = useState(false);
  const [shareError, setShareError]           = useState<string | null>(null);
  const [generatedShareUrl, setGeneratedShareUrl] = useState<string | null>(null);

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
      const data = await res.json() as { shareUrl?: string; error?: string };
      if (!res.ok) { setShareError(data.error ?? 'Failed to generate share link'); return; }
      if (data.shareUrl) setGeneratedShareUrl(data.shareUrl);
    } catch {
      setShareError('Network error — could not generate share link');
    } finally {
      setShareGenerating(false);
    }
  }

  // ── Comments ───────────────────────────────────────────────────────────────
  const [comments,        setComments]        = useState<FrameIOComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText,     setCommentText]     = useState('');
  const [commentPosting,  setCommentPosting]  = useState(false);
  const [commentError,    setCommentError]    = useState<string | null>(null);
  const commentEndRef = useRef<HTMLDivElement>(null);

  const fetchComments = useCallback(async () => {
    if (!asset?.frameio.assetId) return;
    setCommentsLoading(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`);
      const data = await res.json() as { comments?: FrameIOComment[]; error?: string };
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

  async function handlePostComment() {
    if (!commentText.trim() || !asset) return;
    setCommentPosting(true);
    setCommentError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/frameio/comments`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: commentText.trim() }),
        },
      );
      const data = await res.json() as { comment?: FrameIOComment; error?: string };
      if (!res.ok) { setCommentError(data.error ?? 'Failed to post comment'); return; }
      if (data.comment) {
        setComments((prev) => [...prev, data.comment!]);
        setCommentText('');
        setTimeout(() => commentEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
    } catch {
      setCommentError('Network error — could not post comment');
    } finally {
      setCommentPosting(false);
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
      {open && <div className="mad-backdrop" onClick={onClose} aria-hidden="true" />}

      <aside className={`mad-panel${open ? ' mad-panel--open' : ''}`} role="dialog" aria-label="Media asset detail">

        {asset && (
          <>
            {/* ── Header ── */}
            <div className="mad-header">
              <div className="mad-header-info">
                <span className="mad-header-title">{asset.name}</span>
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
                    <div className="mad-video-wrap">
                      <video
                        className="mad-video"
                        src={src}
                        controls
                        preload="metadata"
                        key={asset.assetId}
                        onError={(e) => {
                          const el = e.currentTarget;
                          el.style.display = 'none';
                          const msg = el.parentElement?.querySelector('.mad-video-unavail');
                          if (msg) (msg as HTMLElement).style.display = 'flex';
                        }}
                      />
                      <div className="mad-video-unavail" style={{ display: 'none' }}>
                        <span>Preview unavailable — Frame.io may still be processing</span>
                        {(asset.frameio.playerUrl ?? asset.frameio.reviewLink) && (
                          <a href={asset.frameio.playerUrl ?? asset.frameio.reviewLink!} target="_blank" rel="noreferrer" className="mad-video-unavail-link">
                            Open in Frame.io ↗
                          </a>
                        )}
                      </div>
                    </div>
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
                    <div className="mad-video-wrap">
                      <video className="mad-video" src={src} controls preload="metadata" key={asset.assetId} />
                    </div>
                  );
                }
                return null;
              })()}

              {/* ── Frame.io section ── */}
              <div className="mad-section">
                <div className="mad-section-head">
                  <span className="mad-section-title">Frame.io</span>
                  <span className={`mad-fio-badge mad-fio-badge--${fioStatus}`}>
                    {FRAMEIO_STATUS_LABEL[fioStatus]}
                  </span>
                </div>

                  {/* Frame.io view link */}
                {(asset.frameio.playerUrl || asset.frameio.reviewLink) && !isUploading && (
                  <a
                    href={asset.frameio.playerUrl ?? asset.frameio.reviewLink!}
                    target="_blank"
                    rel="noreferrer"
                    className="mad-fio-review-link-btn"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                      <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    Open in Frame.io
                  </a>
                )}

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

                {/* Local error (e.g. network, bad request) */}
                {fioError && <p className="mad-error">{fioError}</p>}
                {/* Server-side error from last background upload attempt */}
                {!fioError && asset.frameio.lastError && fioStatus === 'none' && (
                  <p className="mad-error">Last attempt failed: {asset.frameio.lastError}</p>
                )}

                {/* Review link — stored on asset (created during upload) */}
                {asset.frameio.reviewLink && !isUploading && (
                  <div className="mad-copy-row">
                    <span className="mad-copy-label">Review link</span>
                    <span className="mad-copy-url">{asset.frameio.reviewLink}</span>
                    <button
                      type="button"
                      className="mad-copy-btn"
                      onClick={() => handleCopyLink(asset.frameio.reviewLink!)}
                    >
                      {copied ? '✓' : 'Copy'}
                    </button>
                  </div>
                )}

                {/* Generate a new share link on demand */}
                {asset.frameio.assetId && !isUploading && !generatedShareUrl && (
                  <button
                    type="button"
                    className="mad-action-btn"
                    onClick={() => void handleGenerateShareLink()}
                    disabled={shareGenerating}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                    </svg>
                    {shareGenerating ? 'Generating…' : 'Generate share link'}
                  </button>
                )}

                {/* Generated share link result */}
                {generatedShareUrl && !isUploading && (
                  <div className="mad-copy-row mad-copy-row--generated">
                    <span className="mad-copy-label">New share link</span>
                    <span className="mad-copy-url">{generatedShareUrl}</span>
                    <button
                      type="button"
                      className="mad-copy-btn mad-copy-btn--primary"
                      onClick={() => handleCopyLink(generatedShareUrl)}
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                )}

                {shareError && <p className="mad-error">{shareError}</p>}
              </div>

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
                              : <div className="mad-comment-avatar mad-comment-avatar--placeholder">{c.authorName[0]}</div>
                            }
                            <span className="mad-comment-author">{c.authorName}</span>
                            {c.timestamp !== null && (
                              <span className="mad-comment-time">{formatTimestamp(c.timestamp)}</span>
                            )}
                            <span className="mad-comment-date">{formatDate(c.createdAt)}</span>
                          </div>
                          <p className="mad-comment-text">{c.text}</p>
                          {c.replies.length > 0 && (
                            <div className="mad-comment-replies">
                              {c.replies.map((r) => (
                                <div key={r.id} className="mad-comment-reply">
                                  <span className="mad-comment-author">{r.authorName}</span>
                                  <p className="mad-comment-text">{r.text}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      <div ref={commentEndRef} />
                    </div>
                  )}

                  <div className="mad-comment-compose">
                    <textarea
                      className="mad-comment-input"
                      rows={2}
                      placeholder="Leave a comment…"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void handlePostComment();
                        }
                      }}
                      disabled={commentPosting}
                    />
                    {commentError && <p className="mad-error">{commentError}</p>}
                    <button
                      type="button"
                      className="mad-action-btn mad-action-btn--primary"
                      onClick={() => void handlePostComment()}
                      disabled={commentPosting || !commentText.trim()}
                    >
                      {commentPosting ? 'Posting…' : 'Post  ⌘↵'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Cloudflare Stream section ── */}
              <div className="mad-section">
                <div className="mad-section-head">
                  <span className="mad-section-title">Push to LeaderPass</span>
                  <span className={`mad-fio-badge mad-fio-badge--${asset.leaderpass.status === 'published' ? 'approved' : asset.leaderpass.status === 'failed' ? 'rejected' : asset.leaderpass.status === 'awaiting_platform' ? 'in_review' : asset.leaderpass.status === 'preparing' ? 'uploading' : 'none'}`}>
                    {LEADERPASS_STATUS_LABEL[asset.leaderpass.status]}
                  </span>
                  {(asset.leaderpass.status !== 'none' || asset.cloudflare.status !== 'none') && (
                    <button
                      type="button"
                      className="mad-subtle-btn"
                      onClick={() => void handleResetLeaderPass()}
                      disabled={lpResetting}
                    >
                      {lpResetting ? 'Resetting…' : 'Reset'}
                    </button>
                  )}
                </div>
                {(asset.leaderpass.status === 'none' || asset.leaderpass.status === 'failed') && (
                  <button
                    type="button"
                    className="mad-action-btn mad-action-btn--cloud"
                    onClick={() => void handlePushToLeaderPass()}
                    disabled={!asset.filePath || lpPublishing}
                  title="Cloudflare Stream push — coming soon"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                    <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
                  </svg>
                    {lpPublishing ? 'Queueingâ€¦' : 'Push to LeaderPass'}
                  </button>
                )}
                <p className="mad-hint">Wiring coming soon — credentials set in .env.local.</p>
              </div>

              {/* ── Transcription section ── */}
              <div className="mad-section">
                <div className="mad-section-head">
                  <span className="mad-section-title">Transcription</span>
                  <span className={`mad-tx-badge mad-tx-badge--${asset.transcription.status}`}>
                    {{
                      none:       'Not Transcribed',
                      queued:     'Queued',
                      processing: 'Transcribing…',
                      done:       'Done',
                      failed:     'Failed',
                    }[asset.transcription.status]}
                  </span>
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

              {/* ── Metadata section ── */}
              <div className="mad-section">
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

              {/* ── File info section ── */}
              <div className="mad-section">
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
          </>
        )}
      </aside>
    </>
  );
}
