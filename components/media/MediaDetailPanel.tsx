'use client';

/**
 * MediaDetailPanel
 *
 * Slide-in right-side drawer for a selected MediaAsset.
 * Mirrors the ScriptEditorPanel pattern — always in DOM, shown/hidden via CSS.
 *
 * Sections:
 *   • Transcription — status badge, re-transcribe button
 *   • Cloudflare Stream — push button (UI only, wiring pending)
 *   • Metadata — editable name / description with PATCH save
 *   • File info — size, path, dates
 */

import { Component, useState, useEffect, useCallback, useRef } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { MediaAsset } from '@/lib/models/media-asset';
import { cloudflarePosterPreviewUrl } from '@/lib/models/media-asset';
import { ShareModal } from '@/components/share/ShareModal';
import { BatchSetThumbnailModal } from '@/components/media/BatchSetThumbnailModal';
import { DomainRestrictionsModal } from '@/components/media/DomainRestrictionsModal';

// ── Theater mode error boundary ────────────────────────────────────────────
// VideoTheaterMode renders untrusted comment text and does live DOM mutations
// (video seek, play/pause) that can throw. Without a boundary, any render
// error here unmounts the entire LPOS page silently. This boundary catches the
// error, logs it, and shows a recoverable prompt instead of a blank screen.
class TheaterErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[theater-mode] render error:', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.85)', zIndex: 9999, flexDirection: 'column', gap: 12, color: '#fff', fontFamily: 'sans-serif' }}>
          <p style={{ margin: 0, fontSize: 14 }}>Theater mode encountered an error.</p>
          <button
            type="button"
            style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: '#4a5568', color: '#fff', cursor: 'pointer', fontSize: 13 }}
            onClick={() => { this.setState({ error: null }); this.props.onReset(); }}
          >
            Close
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import { VideoTheaterMode } from './VideoTheaterMode';
import { MediaPlayer } from './MediaPlayer';
import { MediaDistributionBar } from './MediaDistributionBar';
import { AssetCommentsSection, useAssetComments } from './AssetComments';


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

function TitleRenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      className="mad-title-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => { if (value.trim() && value !== initial) onCommit(value.trim()); else onCancel(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter')  { e.preventDefault(); if (value.trim()) onCommit(value.trim()); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** A share that includes this video (the unified Share system). */
interface AssetShareLink {
  shareId:  string;
  shareUrl: string;
  name:     string;
}

export function MediaDetailPanel({ asset, projectId, onClose, onUpdated, onGoToTranscript }: Readonly<Props>) {
  const open = asset !== null;
  // Latest playhead time reported by the compact MediaPlayer (via onCurrentTimeChange).
  // Lets the sidebar compose box capture "comment at current playhead" without
  // holding a ref to the video element, which now lives inside MediaPlayer.
  const sidebarTimeRef = useRef(0);

  const { toast } = useToast();
  const [renamingTitle,               setRenamingTitle]               = useState(false);
  const [showLeaderPassErrorDetails, setShowLeaderPassErrorDetails] = useState(false);
  const [theaterSrc,                 setTheaterSrc]                 = useState<string | null>(null);
  const [theaterSeekTarget,          setTheaterSeekTarget]          = useState<number | null>(null);
  const [sidebarSeekTarget,          setSidebarSeekTarget]          = useState<number | null>(null);
  const [advancedOpen,               setAdvancedOpen]               = useState(false);

  function openTheater(src: string, currentTime = 0) {
    setTheaterSrc(src);
    if (currentTime > 0) setTheaterSeekTarget(currentTime);
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
    setShowLeaderPassErrorDetails(false);
    setRenamingTitle(false);
  }, [asset]);

  // Reset per-asset state only when the selected asset changes (not on re-renders of the same asset)
  useEffect(() => {
    setExistingShareLinks([]);
  }, [asset?.assetId]);

  async function commitRenameTitle(newName: string) {
    setRenamingTitle(false);
    if (!asset || !newName.trim() || newName.trim() === asset.name) return;
    const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.warning) {
      toast({ id: `rename-warn:${asset.assetId}`, kind: 'publish', tone: 'error', title: 'Rename partially failed', body: data.warning });
    }
    if (res.ok) onUpdated();
  }

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

  // ── Share links ────────────────────────────────────────────────────────────
  const [copiedShareId, setCopiedShareId]     = useState<string | null>(null);
  const [existingShareLinks, setExistingShareLinks] = useState<AssetShareLink[]>([]);
  const [managingShareId, setManagingShareId] = useState<string | null>(null);

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

  const [lpPublishing, setLpPublishing] = useState(false);
  const [lpError, setLpError] = useState<string | null>(null);
  const [lpResetting, setLpResetting] = useState(false);

  const [cfEmbedCopied,    setCfEmbedCopied]    = useState(false);
  const [assetLinkCopied,  setAssetLinkCopied]  = useState(false);
  const [showThumbModal,   setShowThumbModal]   = useState(false);
  const [showDomainsModal, setShowDomainsModal] = useState(false);
  const [cfResetConfirm,   setCfResetConfirm]   = useState(false);

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

  // Every copy button in the panel confirms with the same gold checkmark
  // (1.5s); a toast appears only when the clipboard write fails.
  async function copyToClipboard(url: string, onCopied: () => void) {
    try {
      await navigator.clipboard.writeText(url);
      onCopied();
    } catch {
      toast({ id: 'copy-failed', kind: 'publish', tone: 'error', title: 'Copy failed', body: 'Could not access the clipboard.' });
    }
  }

  function handleCopyLink(url: string, shareId: string) {
    void copyToClipboard(url, () => {
      setCopiedShareId(shareId);
      setTimeout(() => setCopiedShareId((cur) => (cur === shareId ? null : cur)), 1500);
    });
  }

  function handleCopyEmbedUrl(url: string) {
    void copyToClipboard(url, () => {
      setCfEmbedCopied(true);
      setTimeout(() => setCfEmbedCopied(false), 1500);
    });
  }

  // Every share that includes this video — listed in the Shares section.
  const fetchShareLinks = useCallback(async (assetId: string) => {
    try {
      const res = await fetch(`/api/share-links?assetId=${encodeURIComponent(assetId)}`);
      if (!res.ok) return;
      const data = await res.json() as { shares: Array<{ id: string; name: string; token: string }> };
      setExistingShareLinks(data.shares.map((s) => ({
        shareId:  s.id,
        shareUrl: `${window.location.origin}/s/${s.token}`,
        name:     s.name,
      })));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (asset?.assetId) void fetchShareLinks(asset.assetId);
  }, [asset?.assetId, fetchShareLinks]);

  // ── Comments ───────────────────────────────────────────────────────────────
  // The comment thread (state, reads, writes, version cycler) lives in the
  // shared useAssetComments hook so the Share viewer runs the same system.
  const ac = useAssetComments({
    projectId,
    assetId:        asset?.assetId ?? null,
    frameioAssetId: asset?.frameio.assetId ?? null,
  });
  const { comments, setComments, pendingTogglesRef, selectedVersionId, isViewingOldVersion } = ac;

  // ── Re-transcribe ──────────────────────────────────────────────────────────
  async function handleRetranscribe() {
    if (!asset) return;
    await fetch(`/api/projects/${projectId}/media/${asset.assetId}/retranscribe`, { method: 'POST' });
    onUpdated();
  }

  // ── Spanish transcribe (additive; coexists with English) ────────────────────
  async function handleSpanishTranscribe() {
    if (!asset) return;
    await fetch(`/api/projects/${projectId}/media/${asset.assetId}/transcribe-es`, { method: 'POST' });
    onUpdated();
  }

  // ── Version selection (drives both the comment thread and the player) ──────
  // Only the latest version is on Cloudflare; older versions play from their
  // own Frame.io file via ?version= on the stream route (see frameio-stream).

  // ── Cloudflare push/repair state (lifted from the old CF section so the
  //    distribution bar shows status and the Advanced "Cloudflare" subsection
  //    can drive the manual push / force-reset). ──────────────────────────────
  const cfStatus     = asset?.cloudflare.status ?? 'none';
  const lpStatus     = asset?.leaderpass.status ?? 'none';
  const cfIsStale    = asset?.cloudflare.isStale ?? false;
  const cfCurrentVer = asset?.frameio.version ?? 1;
  const cfIsActive   = lpStatus === 'preparing' || cfStatus === 'uploading' || cfStatus === 'processing';
  const cfIsPushable = !cfIsActive && (lpStatus === 'none' || lpStatus === 'failed' || cfStatus === 'failed' || cfIsStale);

  return (
    <>
      {theaterSrc && asset && (
        <TheaterErrorBoundary onReset={() => setTheaterSrc(null)}>
          <VideoTheaterMode
            src={theaterSrc}
            assetId={asset.assetId}
            projectId={projectId}
            frameioAssetId={asset.frameio.assetId}
            comments={comments}
            seekTarget={theaterSeekTarget}
            onClose={t => { setSidebarSeekTarget(t > 0 ? t : null); setTheaterSrc(null); }}
            onCommentPosted={(comment) => setComments(prev => [...prev, comment])}
            onCommentCompleted={(id, completed) => {
              // Theater mode toggles via its own PATCH (already succeeded here);
              // record the guard so the webhook echo can't reset it before
              // Frame.io's read catches up. fetchComments clears it on confirm.
              pendingTogglesRef.current.set(id, completed);
              setComments(prev => prev.map(c => c.id === id ? { ...c, completed } : c));
            }}
            onCommentEdited={(id, text) =>
              setComments(prev => prev.map(c => c.id === id ? { ...c, text } : c))
            }
            onReplyPosted={(reply, parentId) =>
              setComments(prev => prev.map(c =>
                c.id === parentId ? { ...c, replies: [...(c.replies ?? []), reply] } : c,
              ))
            }
            onSeekHandled={() => setTheaterSeekTarget(null)}
          />
        </TheaterErrorBoundary>
      )}

      {cfResetConfirm && (
        <div className="mad-confirm-overlay" onClick={() => setCfResetConfirm(false)}>
          <div className="mad-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="mad-confirm-title">Reset & Re-push?</p>
            <p className="mad-confirm-body">The current Cloudflare Stream will be deleted and a new upload queued from the current LPOS version. The video will be temporarily unavailable.</p>
            <div className="mad-confirm-actions">
              <button type="button" className="mad-action-btn" onClick={() => setCfResetConfirm(false)}>Cancel</button>
              <button
                type="button"
                className="mad-action-btn mad-action-btn--danger"
                disabled={lpResetting}
                onClick={async () => { setCfResetConfirm(false); await handleResetLeaderPass(); }}
              >
                {lpResetting ? 'Resetting…' : 'Reset & Re-push'}
              </button>
            </div>
          </div>
        </div>
      )}

      {open && <div className="mad-backdrop" onClick={onClose} aria-hidden="true" />}

      <aside className={`mad-panel${open ? ' mad-panel--open' : ''}`} role="dialog" aria-label="Media asset detail">

        {asset && (
          <>
            {/* ── Header ── */}
            <div className="mad-header">
              <div className="mad-header-info">
                <div className="mad-header-title-row">
                  {renamingTitle ? (
                    <TitleRenameInput
                      initial={asset.name}
                      onCommit={(v) => void commitRenameTitle(v)}
                      onCancel={() => setRenamingTitle(false)}
                    />
                  ) : (
                    <span
                      className="mad-header-title"
                      onDoubleClick={() => setRenamingTitle(true)}
                      title="Double-click to rename"
                    >{asset.name}</span>
                  )}
                  {(() => {
                    const slot = VERSION_COLORS[(asset.frameio.version - 1) % VERSION_COLORS.length];
                    return (
                      <span className="ma-badge ma-badge--version" style={{ background: slot.bg, color: slot.color }}>
                        v{asset.frameio.version}
                      </span>
                    );
                  })()}
                </div>
                {/* ── Compact meta: size · duration · filename ── */}
                {(() => {
                  const parts: string[] = [];
                  if (asset.fileSize !== null) parts.push(formatBytes(asset.fileSize));
                  if (asset.duration !== null && asset.duration > 0) parts.push(formatTimestamp(asset.duration));
                  if (asset.originalFilename) parts.push(asset.originalFilename);
                  return parts.length ? <p className="mad-header-meta-row">{parts.join(' · ')}</p> : null;
                })()}
              </div>
              <button
                type="button"
                className={`mad-close-btn mad-copyable${assetLinkCopied ? ' is-copied' : ''}`}
                onClick={() => void copyToClipboard(
                  `${window.location.origin}/projects/${projectId}?assetId=${asset.assetId}`,
                  () => { setAssetLinkCopied(true); setTimeout(() => setAssetLinkCopied(false), 1500); },
                )}
                aria-label={assetLinkCopied ? 'Link copied' : 'Copy link for a teammate'}
                title={assetLinkCopied ? 'Copied' : 'Copy link for a teammate'}
              >
                {assetLinkCopied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 17 20 12 15 7"/>
                    <path d="M4 18v-2a4 4 0 0 1 4-4h12"/>
                  </svg>
                )}
              </button>
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
                   2. Neither on Frame.io nor Cloudflare → local NAS stream (host only).
                   The frameio-stream route resolves Cloudflare first, so an asset that
                   skipped Frame.io (auto upload off) still plays CF HLS. ── */}
              {(() => {
                const audio = isAudioFile(asset.originalFilename ?? asset.name);
                if (asset.frameio.assetId || asset.cloudflare?.uid) {
                  // When viewing an older version, request it explicitly so the
                  // route serves that version's Frame.io file (the latest's CF
                  // video is the only one on Cloudflare). Latest → no param → CF.
                  const src = isViewingOldVersion
                    ? `/api/projects/${projectId}/media/${asset.assetId}/frameio-stream?version=${encodeURIComponent(selectedVersionId!)}`
                    : `/api/projects/${projectId}/media/${asset.assetId}/frameio-stream`;
                  return audio ? (
                    <div className="mad-audio-wrap">
                      <svg className="mad-audio-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                      </svg>
                      <audio className="mad-audio-player" src={src} controls preload="metadata" key={asset.assetId} />
                    </div>
                  ) : (
                    <>
                      <MediaPlayer
                        variant="compact"
                        src={src}
                        assetId={asset.assetId}
                        projectId={projectId}
                        frameioAssetId={asset.frameio.assetId ?? null}
                        comments={comments}
                        seekTarget={sidebarSeekTarget}
                        onSeekHandled={() => setSidebarSeekTarget(null)}
                        onTheaterOpen={t => openTheater(src, t)}
                        onCurrentTimeChange={t => { sidebarTimeRef.current = t; }}
                      />
                      <MediaDistributionBar
                        asset={asset}
                        isViewingOldVersion={isViewingOldVersion}
                        streamUrlCopied={cfEmbedCopied}
                        onCopyStreamUrl={handleCopyEmbedUrl}
                        onReplaceThumbnail={() => setShowThumbModal(true)}
                        onSecurity={() => setShowDomainsModal(true)}
                      />
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
                      <MediaPlayer
                        variant="compact"
                        src={src}
                        assetId={asset.assetId}
                        projectId={projectId}
                        frameioAssetId={null}
                        comments={comments}
                        seekTarget={sidebarSeekTarget}
                        onSeekHandled={() => setSidebarSeekTarget(null)}
                        onTheaterOpen={t => openTheater(src, t)}
                        onCurrentTimeChange={t => { sidebarTimeRef.current = t; }}
                      />
                    </>
                  );
                }
                return null;
              })()}

              {/* ── Comments ── */}
              <AssetCommentsSection
                ac={ac}
                onSeek={(t) => setSidebarSeekTarget(t)}
                getCurrentTime={() => sidebarTimeRef.current}
              />

              {/* ── Shares that include this video (reference only; hidden when none) ── */}
              {existingShareLinks.length > 0 && (
                <div className="mad-section mad-shares">
                  <span className="mad-section-title">Shares · {existingShareLinks.length}</span>
                  <ul className="mad-shares-list">
                    {existingShareLinks.map((link) => (
                      <li key={link.shareId} className="mad-shares-row">
                        <button
                          type="button"
                          className="mad-shares-name"
                          onClick={() => setManagingShareId(link.shareId)}
                          title="Open this share"
                        >
                          {link.name}
                        </button>
                        <button
                          type="button"
                          className={`mad-icon-btn mad-copyable${copiedShareId === link.shareId ? ' is-copied' : ''}`}
                          onClick={() => handleCopyLink(link.shareUrl, link.shareId)}
                          aria-label={copiedShareId === link.shareId ? 'Share link copied' : 'Copy share link'}
                          title={copiedShareId === link.shareId ? 'Copied' : 'Copy share link'}
                        >
                          {copiedShareId === link.shareId ? (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                          ) : (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                          )}
                        </button>
                        <button
                          type="button"
                          className="mad-icon-btn"
                          onClick={() => setManagingShareId(link.shareId)}
                          aria-label="Open this share"
                          title="Open this share"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Advanced (collapsible) ── */}
              <div className="mad-section mad-advanced-section">
                <button
                  type="button"
                  className="mad-advanced-toggle"
                  onClick={() => setAdvancedOpen(o => !o)}
                  aria-expanded={advancedOpen}
                >
                  <span className="mad-section-title">Advanced</span>
                  <svg
                    className={`mad-advanced-chevron${advancedOpen ? ' mad-advanced-chevron--open' : ''}`}
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>

                {advancedOpen && (
                  <div className="mad-advanced-content">

                    {/* Cloudflare repair — auto-upload handles the happy path;
                         this is the manual push / force-reset fallback. */}
                    <div className="mad-more-info-sub">
                      <span className="mad-section-title">Cloudflare</span>
                      {cfIsPushable && (
                        <button
                          type="button"
                          className="mad-action-btn mad-action-btn--primary"
                          onClick={() => void handlePushToLeaderPass()}
                          disabled={lpPublishing || !asset.filePath}
                          title={!asset.filePath ? 'No local file — cannot upload' : undefined}
                          style={{ marginTop: 8 }}
                        >
                          {lpPublishing
                            ? 'Queuing…'
                            : cfIsStale
                              ? `Push v${cfCurrentVer} to Cloudflare`
                              : (cfStatus === 'failed' || lpStatus === 'failed') ? 'Retry Cloudflare push' : 'Push to Cloudflare'}
                        </button>
                      )}
                      {cfIsActive && (
                        <div className="mad-uploading-row" style={{ marginTop: 8 }}>
                          <span className="mad-spinner" aria-hidden="true" />
                          <span className="mad-uploading-label">
                            {cfStatus === 'processing'
                              ? 'Cloudflare is processing…'
                              : `Uploading… ${asset.cloudflare.progress ? `${asset.cloudflare.progress}%` : ''}`.trim()}
                          </span>
                          <button
                            type="button"
                            className="mad-lp-force-reset"
                            onClick={() => void handleResetLeaderPass()}
                            disabled={lpResetting}
                            title="Force-reset if the upload is stuck"
                          >
                            {lpResetting ? 'Resetting…' : 'Force reset'}
                          </button>
                        </div>
                      )}
                      {!cfIsPushable && !cfIsActive && (cfStatus === 'ready' || lpStatus === 'awaiting_platform') && (
                        <button
                          type="button"
                          className="mad-action-btn"
                          onClick={() => setCfResetConfirm(true)}
                          disabled={lpResetting}
                          style={{ marginTop: 8 }}
                        >
                          Reset &amp; re-push
                        </button>
                      )}
                      {asset.leaderpass.lastPreparedAt && (
                        <p className="mad-hint">Prepared {formatDate(asset.leaderpass.lastPreparedAt)}</p>
                      )}
                      {(lpError || asset.leaderpass.lastError || asset.cloudflare.lastError) && (() => {
                        const message   = lpError ?? asset.leaderpass.lastError ?? asset.cloudflare.lastError ?? '';
                        const preview   = summarizeError(message);
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
                                onClick={() => setShowLeaderPassErrorDetails(c => !c)}
                              >
                                {showLeaderPassErrorDetails ? 'Show less' : 'Show full error'}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Transcription — moved out of the main sidebar; the strip
                         badge under the player carries the at-a-glance status. */}
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
                        {asset.transcription.status !== 'queued' && asset.transcription.status !== 'processing' && (
                          <button
                            type="button"
                            className="mad-icon-btn"
                            onClick={handleRetranscribe}
                            disabled={!asset.filePath}
                            title={!asset.filePath ? 'No local file path' : asset.transcription.status === 'done' ? 'Re-transcribe' : 'Start transcription'}
                            aria-label="Re-transcribe"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                            </svg>
                          </button>
                        )}
                      </div>
                      {asset.transcription.status === 'done' && asset.transcription.jobId && onGoToTranscript && (
                        <button
                          type="button"
                          className="mad-action-btn mad-action-btn--primary"
                          onClick={() => onGoToTranscript(asset.transcription.jobId!)}
                          style={{ marginTop: 8 }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                          </svg>
                          Go to Transcript
                        </button>
                      )}
                      {asset.transcription.completedAt && (
                        <p className="mad-hint">Completed {formatDate(asset.transcription.completedAt)}</p>
                      )}
                    </div>

                    {/* Spanish transcription — additive, coexists with English.
                         Row is always shown so the Spanish pass can be started;
                         once done it exposes a "Go to Spanish transcript" and, on a
                         newer asset version, a stale-version prompt to re-run. */}
                    {(() => {
                      const es = asset.transcriptionEs;
                      const esStatus = es?.status ?? 'none';
                      const esStale = Boolean(es && es.fromPriorVersion && esStatus !== 'none');
                      return (
                        <div className="mad-more-info-sub">
                          <div className="mad-section-head">
                            <span className="mad-section-title">Spanish Transcription</span>
                            <div className="mad-tx-status-group">
                              <span className={`mad-tx-badge mad-tx-badge--${esStatus}`}>
                                {{
                                  none:       'Not Transcribed',
                                  queued:     'Queued',
                                  processing: 'Transcribing…',
                                  done:       'Done',
                                  failed:     'Failed',
                                }[esStatus]}
                              </span>
                              {esStale && (
                                <span
                                  className="mad-tx-version-pill"
                                  title={`Spanish transcript is from version ${es?.sourceVersionNumber ?? '?'} — re-transcribe for the current version`}
                                >
                                  v{es?.sourceVersionNumber ?? '?'}
                                </span>
                              )}
                            </div>
                            {esStatus !== 'queued' && esStatus !== 'processing' && (
                              <button
                                type="button"
                                className="mad-icon-btn"
                                onClick={handleSpanishTranscribe}
                                disabled={!asset.filePath}
                                title={!asset.filePath ? 'No local file path' : esStatus === 'done' ? 'Re-transcribe (Spanish)' : 'Start Spanish transcription'}
                                aria-label="Transcribe Spanish"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                                </svg>
                              </button>
                            )}
                          </div>
                          {esStale && (
                            <p className="mad-hint">A newer version was uploaded after this Spanish transcript — re-transcribe to refresh it.</p>
                          )}
                          {esStatus === 'done' && es?.jobId && onGoToTranscript && (
                            <button
                              type="button"
                              className="mad-action-btn mad-action-btn--primary"
                              onClick={() => onGoToTranscript(es.jobId!)}
                              style={{ marginTop: 8 }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                                <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                              </svg>
                              Go to Spanish Transcript
                            </button>
                          )}
                          {esStatus === 'done' && es?.completedAt && (
                            <p className="mad-hint">Completed {formatDate(es.completedAt)}</p>
                          )}
                        </div>
                      );
                    })()}

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

      {/* Per-asset custom thumbnail uploader — reuses the batch modal with a 1-item assetIds array.
          The endpoint POSTs the image to Cloudflare Images and patches asset.cloudflare.posterUrl,
          which is what posterPreviewUrl above reads from. */}
      {showThumbModal && asset && (
        <BatchSetThumbnailModal
          projectId={projectId}
          assetIds={[asset.assetId]}
          currentThumbnails={[cloudflarePosterPreviewUrl(asset.cloudflare)].filter((u): u is string => Boolean(u))}
          onClose={() => setShowThumbModal(false)}
          onDone={() => { setShowThumbModal(false); onUpdated(); }}
        />
      )}

      {/* Share window opened from the Shares section — above the sidebar. */}
      {managingShareId && (
        <div className="mad-share-modal-host">
          <ShareModal
            shareId={managingShareId}
            projectId={projectId}
            onClose={() => { setManagingShareId(null); if (asset) void fetchShareLinks(asset.assetId); }}
            onChanged={() => { if (asset) void fetchShareLinks(asset.assetId); }}
          />
        </div>
      )}

      {/* Per-asset Cloudflare allowedOrigins editor. Reads current value from
          the Cloudflare API on open and POSTs the full list on save. */}
      {showDomainsModal && asset && (
        <DomainRestrictionsModal
          projectId={projectId}
          assetId={asset.assetId}
          assetName={asset.name}
          onClose={() => setShowDomainsModal(false)}
          onSaved={() => { setShowDomainsModal(false); onUpdated(); }}
        />
      )}
    </>
  );
}
