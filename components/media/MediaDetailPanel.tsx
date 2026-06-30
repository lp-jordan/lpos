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

import { Component, useState, useEffect, useCallback, useRef } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { io as ioClient }                           from 'socket.io-client';
import { useToast } from '@/contexts/ToastContext';
import type { MediaAsset } from '@/lib/models/media-asset';
import type { FrameIOComment } from '@/lib/services/frameio';
import { formatTimecode } from '@/lib/utils/time';

type CommentRow = FrameIOComment & { canEdit?: boolean; fromFrame?: boolean; mirrorAbandoned?: boolean };
import type { AssetShareLink } from '@/lib/store/asset-share-links-store';
import { DeliverableModal } from '@/components/projects/DeliverableModal';
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
  const [reviewLinksOpen,            setReviewLinksOpen]            = useState(false);

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

  // ── Frame.io ───────────────────────────────────────────────────────────────
  const [fioUploading, setFioUploading]       = useState(false);
  const [fioError, setFioError]               = useState<string | null>(null);
  const [copiedShareId, setCopiedShareId]     = useState<string | null>(null);
  // Phase E: shareGenerating + shareError dropped — DeliverableModal owns those.
  const [showDeliverableModal, setShowDeliverableModal] = useState(false);
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

  function handleCopyLink(url: string, shareId: string) {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedShareId(shareId);
    setTimeout(() => setCopiedShareId((cur) => (cur === shareId ? null : cur)), 2000);
  }

  function handleCopyEmbedUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
    setCfEmbedCopied(true);
    setTimeout(() => setCfEmbedCopied(false), 2000);
  }

  // Phase E: reads from the new /deliverables endpoint and shape-maps to the
  // legacy AssetShareLink shape so the existing dropdown JSX keeps working.
  // The downstream-display fields we use are shareId, shareUrl, name, createdAt —
  // all present in both shapes.
  const fetchShareLinks = useCallback(async (assetId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${assetId}/deliverables`);
      if (!res.ok) return;
      const data = await res.json() as {
        deliverables: Array<{ deliverableId: string; name: string; shortUrl: string; createdAt: string }>;
      };
      setExistingShareLinks(data.deliverables.map((d) => ({
        shareId: d.deliverableId,
        shareUrl: d.shortUrl,
        name: d.name,
        createdAt: d.createdAt,
      })));
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => {
    if (asset?.assetId) void fetchShareLinks(asset.assetId);
  }, [asset?.assetId, fetchShareLinks]);

  // Phase E: shareId here is actually a deliverableId (we reshaped the response
  // upstream). Deleting goes through the unified /deliverables endpoint, which
  // also deletes the underlying Frame.io share so the link stops resolving.
  async function handleDeleteShareLink(shareId: string) {
    if (!asset) return;
    setDeletingShareId(shareId);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/deliverables/${shareId}`,
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

  // Sidebar compose state — mirrors theater-mode's compose box so users can
  // leave timed top-level comments without entering theater. Focus pauses the
  // sidebar video and snaps the timestamp to the nearest NDF frame boundary
  // (same math the theater compose uses); blur leaves the timestamp pinned so
  // the user can scrub elsewhere without losing their attached time.
  const [composeText,    setComposeText]    = useState('');
  const [composeTime,    setComposeTime]    = useState(0);
  const [composePosting, setComposePosting] = useState(false);
  const [composeError,   setComposeError]   = useState<string | null>(null);
  const composeInputRef = useRef<HTMLInputElement>(null);

  // Phase 3: version cycler. The panel always opens on the latest version
  // (the asset's "current" version per the legacy contract). Users can
  // click chips at the top of the comment section to view older versions'
  // threads. Comments are pinned to a specific asset_version_id (locked
  // §11 #1), so each version has its own list.
  interface VersionInfo {
    assetVersionId: string;
    versionNumber:  number;
    createdAt:      string;
    commentCount:   number;
    isLatest:       boolean;
  }
  const [versions,           setVersions]          = useState<VersionInfo[]>([]);
  const [selectedVersionId,  setSelectedVersionId] = useState<string | null>(null);
  const [versionMenuOpen,    setVersionMenuOpen]   = useState(false);

  // Holds an optimistic completed-toggle until a refetch confirms Frame.io has
  // caught up. The webhook echo (comment.completed) arrives a beat *after* our
  // PATCH resolves, and Frame.io's read API briefly lags its own webhook, so a
  // refetch in that window returns the pre-toggle value. We keep masking with
  // the optimistic value until a fetched comment's `completed` matches it —
  // only then is the write known to have propagated, so we drop the guard.
  const pendingTogglesRef = useRef<Map<string, boolean>>(new Map());

  const fetchComments = useCallback(async () => {
    // Frame.io optional: comments load for any asset, not just Frame.io ones.
    if (!asset?.assetId) return;
    setCommentsLoading(true);
    try {
      // Phase 3: ?version=<id> scopes the read to a specific version when
      // the user is browsing an older one via the chips. No param → latest
      // (preserves legacy contract for callers that don't know about chips).
      const qs   = selectedVersionId ? `?version=${encodeURIComponent(selectedVersionId)}` : '';
      const res  = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/comments${qs}`);
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
  }, [asset?.assetId, asset?.frameio.assetId, projectId, selectedVersionId]);

  // Phase 3: fetch the version list when the asset opens. Default the
  // selected version to the latest (matches what the user sees today before
  // they touch the chips).
  const fetchVersions = useCallback(async () => {
    if (!asset?.assetId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/media/${asset.assetId}/versions`);
      const data = await res.json() as { versions?: VersionInfo[]; error?: string };
      if (data.versions) {
        setVersions(data.versions);
        // Only set selected on initial load — don't clobber a user pick when
        // refresh-fired versions list comes back. setSelectedVersionId
        // becomes null only when the asset id changes (see effect below).
        setSelectedVersionId((prev) => prev ?? data.versions?.find((v) => v.isLatest)?.assetVersionId ?? null);
      }
    } catch { /* ignore */ }
  }, [asset?.assetId, projectId]);

  // Load comments + versions when panel opens. Also clear selected version
  // when switching between assets so the new asset opens on its latest.
  useEffect(() => {
    // Frame.io optional: load versions for any asset so its comments resolve.
    setComments([]);
    setSelectedVersionId(null);    // reset; fetchVersions will populate
    if (asset?.assetId) {
      void fetchVersions();
    } else {
      setVersions([]);
    }
  }, [asset?.assetId, fetchVersions]);

  // Whenever the selected version changes, refetch comments.
  useEffect(() => {
    if (asset?.assetId && selectedVersionId) {
      void fetchComments();
    }
  }, [asset?.assetId, selectedVersionId, fetchComments]);

  // Real-time comment refresh via Frame.io webhook → Socket.io push.
  // The server emits 'frameio:comments:refresh' whenever Frame.io fires any
  // comment event (created/updated/completed/deleted). We re-fetch only when
  // the event is for the asset currently open in this panel.
  useEffect(() => {
    if (!asset?.frameio.assetId) return;
    const { assetId, projectId: pid } = { assetId: asset.assetId, projectId };
    const socket = ioClient('/', { transports: ['websocket'] });
    socket.on(
      'frameio:comments:refresh',
      (data: { projectId: string; assetId: string }) => {
        if (data.projectId === pid && data.assetId === assetId) {
          void fetchComments();
        }
      },
    );
    return () => { socket.disconnect(); };
  }, [asset?.assetId, asset?.frameio.assetId, projectId, fetchComments]);

  // Phase 1 (local-comments refactor): the 5-minute fallback poll has been
  // removed. Reads now hit the local media_comments table (kept fresh by
  // the webhook handler's shadow capture + the LPOS-side route's dual-
  // write), so there's no Frame.io round-trip to lag. The existing socket-
  // refresh listener above (frameio:comments:refresh) is the primary signal
  // for live updates. See docs/local-comments-refactor-spec.md §8.

  async function handleUpdateComment(commentId: string) {
    if (!asset || !editText.trim()) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/comments`,
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
        `/api/projects/${projectId}/media/${asset.assetId}/comments`,
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
        `/api/projects/${projectId}/media/${asset.assetId}/comments`,
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

  // Sidebar compose — mirrors VideoTheaterMode.handlePostComment. POSTs a
  // top-level comment with the (NDF-quantized) timestamp captured at focus.
  // Optimistically appends to the local list so it appears immediately even
  // though Frame.io won't have mirrored yet.
  async function handlePostComment() {
    if (!asset || !composeText.trim()) return;
    setComposePosting(true);
    setComposeError(null);
    try {
      const res  = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/comments`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text:      composeText.trim(),
            timestamp: composeTime,
          }),
        },
      );
      const data = await res.json() as { comment?: CommentRow; error?: string };
      if (!res.ok) { setComposeError(data.error ?? 'Failed to post'); return; }
      if (data.comment) {
        setComments(prev => [...prev, data.comment!]);
        setComposeText('');
        setComposeError(null);
      }
    } catch {
      setComposeError('Network error');
    } finally {
      setComposePosting(false);
    }
  }

  async function handleToggleComplete(commentId: string, completed: boolean) {
    if (!asset) return;
    pendingTogglesRef.current.set(commentId, completed);
    setComments(prev => prev.map(c => c.id === commentId ? { ...c, completed } : c));
    try {
      const res = await fetch(
        `/api/projects/${projectId}/media/${asset.assetId}/comments`,
        {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ commentId, completed }),
        },
      );
      if (!res.ok) throw new Error('server error');
      // Leave the guard in place on success — fetchComments clears it once
      // Frame.io's read reflects the toggle. Clearing it here would re-expose
      // the optimistic value to the webhook echo that lands moments later.
    } catch {
      pendingTogglesRef.current.delete(commentId);
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

  // ── Version selection (drives both the comment thread and the player) ──────
  // Only the latest version is on Cloudflare; older versions play from their
  // own Frame.io file via ?version= on the stream route (see frameio-stream).
  const latestVersionId     = versions.find((v) => v.isLatest)?.assetVersionId ?? null;
  const selectedVersion     = versions.find((v) => v.assetVersionId === selectedVersionId) ?? null;
  const isViewingOldVersion = !!selectedVersionId && !!latestVersionId && selectedVersionId !== latestVersionId;

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
                className={`mad-close-btn mad-copy-link-btn${assetLinkCopied ? ' mad-copy-link-btn--copied' : ''}`}
                onClick={async () => {
                  const url = `${window.location.origin}/projects/${projectId}?assetId=${asset.assetId}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    setAssetLinkCopied(true);
                    setTimeout(() => setAssetLinkCopied(false), 1800);
                    toast({ id: `copy-link:${asset.assetId}`, kind: 'publish', tone: 'success', title: 'Link copied', body: 'Share this URL with a teammate to open this asset.' });
                  } catch {
                    toast({ id: `copy-link-err:${asset.assetId}`, kind: 'publish', tone: 'error', title: 'Copy failed', body: 'Could not access the clipboard. Copy manually from the address bar.' });
                  }
                }}
                aria-label={assetLinkCopied ? 'Link copied' : 'Copy link to this asset'}
                title={assetLinkCopied ? 'Link copied' : 'Copy link to this asset'}
              >
                {assetLinkCopied ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <span className="mad-copy-link-label">Link copied</span>
                  </>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/>
                    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/>
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
                   2. Not on Frame.io → fall back to local NAS stream (host only). ── */}
              {(() => {
                const audio = isAudioFile(asset.originalFilename ?? asset.name);
                if (asset.frameio.assetId) {
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
                      <div className="mad-video-theater-row">
                        {/* Review links dropdown */}
                        {existingShareLinks.length > 0 && (
                          <div className="mad-review-links-wrap">
                            <button
                              type="button"
                              className={`mad-action-btn mad-review-links-btn${reviewLinksOpen ? ' mad-review-links-btn--active' : ''}`}
                              onClick={() => setReviewLinksOpen(o => !o)}
                              title={`${existingShareLinks.length} review link${existingShareLinks.length !== 1 ? 's' : ''}`}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/>
                                <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/>
                              </svg>
                              {existingShareLinks.length}
                            </button>
                            {reviewLinksOpen && (
                              <>
                                <div className="mad-review-links-backdrop" onClick={() => setReviewLinksOpen(false)} />
                                <div className="mad-review-links-menu">
                                  {existingShareLinks.map((link) => (
                                    <div key={link.shareId} className="mad-review-links-item">
                                      <span className="mad-review-links-name">{link.name}</span>
                                      <button
                                        type="button"
                                        className="mad-icon-btn"
                                        onClick={() => handleCopyLink(link.shareUrl, link.shareId)}
                                        title="Copy link"
                                      >
                                        {copiedShareId === link.shareId ? '✓' : (
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                          </svg>
                                        )}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <MediaDistributionBar
                        asset={asset}
                        isViewingOldVersion={isViewingOldVersion}
                        streamUrlCopied={cfEmbedCopied}
                        onCopyStreamUrl={handleCopyEmbedUrl}
                        onReplaceThumbnail={() => setShowThumbModal(true)}
                        onSecurity={() => setShowDomainsModal(true)}
                        frameioLink={asset.frameio.playerUrl ?? asset.frameio.reviewLink ?? null}
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
                      {existingShareLinks.length > 0 && (
                        <div className="mad-video-theater-row">
                          <div className="mad-review-links-wrap">
                            <button
                              type="button"
                              className={`mad-action-btn mad-review-links-btn${reviewLinksOpen ? ' mad-review-links-btn--active' : ''}`}
                              onClick={() => setReviewLinksOpen(o => !o)}
                              title={`${existingShareLinks.length} review link${existingShareLinks.length !== 1 ? 's' : ''}`}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/>
                                <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/>
                              </svg>
                              {existingShareLinks.length}
                            </button>
                            {reviewLinksOpen && (
                              <>
                                <div className="mad-review-links-backdrop" onClick={() => setReviewLinksOpen(false)} />
                                <div className="mad-review-links-menu">
                                  {existingShareLinks.map((link) => (
                                    <div key={link.shareId} className="mad-review-links-item">
                                      <span className="mad-review-links-name">{link.name}</span>
                                      <button
                                        type="button"
                                        className="mad-icon-btn"
                                        onClick={() => handleCopyLink(link.shareUrl, link.shareId)}
                                        title="Copy link"
                                      >
                                        {copiedShareId === link.shareId ? '✓' : (
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                          </svg>
                                        )}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      )}
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

              {/* ── Comments (LPOS-owned; Frame.io optional) ── */}
              {(
                <div className="mad-section mad-comments-section">
                  <div className="mad-section-head">
                    <span className="mad-section-title">Comments</span>
                    {comments.length > 0 && (
                      <span className="mad-comments-count">{comments.length}</span>
                    )}
                    <span className="mad-head-spacer" />

                    {/* Version selector — right-justified. Switching a version
                         swaps both this comment thread AND the player (older
                         versions play from Frame.io; latest plays from CF). */}
                    {versions.length > 1 && (
                      <div className="mad-version-select">
                        <button
                          type="button"
                          className={`mad-version-select-btn${isViewingOldVersion ? ' mad-version-select-btn--old' : ''}`}
                          onClick={() => setVersionMenuOpen((o) => !o)}
                          title="Switch version"
                          aria-haspopup="listbox"
                          aria-expanded={versionMenuOpen}
                        >
                          v{selectedVersion?.versionNumber ?? '?'}{isViewingOldVersion ? '' : ' · latest'}
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        {versionMenuOpen && (
                          <>
                            <div className="mad-version-menu-backdrop" onClick={() => setVersionMenuOpen(false)} />
                            <div className="mad-version-menu" role="listbox">
                              {versions.map((v) => (
                                <button
                                  key={v.assetVersionId}
                                  type="button"
                                  role="option"
                                  aria-selected={selectedVersionId === v.assetVersionId}
                                  className={`mad-version-menu-item${selectedVersionId === v.assetVersionId ? ' is-active' : ''}`}
                                  onClick={() => { setSelectedVersionId(v.assetVersionId); setVersionMenuOpen(false); }}
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

                  {/* Viewing an older version → make it obvious + one-click back. */}
                  {isViewingOldVersion && (
                    <div className="mad-version-banner">
                      <span className="mad-version-banner-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Viewing v{selectedVersion?.versionNumber} · Frame.io
                      </span>
                      <button
                        type="button"
                        className="mad-version-back"
                        onClick={() => latestVersionId && setSelectedVersionId(latestVersionId)}
                      >
                        Back to current
                      </button>
                    </div>
                  )}

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
                            {c.mirrorAbandoned && (
                              <span
                                className="mad-comment-mirror-warn"
                                title="Couldn't sync to Frame.io — clients viewing the review link won't see this comment."
                                aria-label="Mirror to Frame.io failed"
                              >
                                !
                              </span>
                            )}
                            {c.timestamp !== null && (() => {
                              const label = `${formatTimecode(c.timestamp)}${c.duration ? ` → ${formatTimecode(c.timestamp + c.duration)}` : ''}`;
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

                  {/* ── Sidebar compose footer ──
                       Mirrors VideoTheaterMode's compose block. Focus pauses
                       the sidebar video and snaps the attached timestamp to
                       the nearest NDF frame boundary. Sits at the end of the
                       comments section (NOT sticky) so it scrolls with the
                       surrounding panel content. */}
                  <div className="mad-comment-compose">
                    <div className="mad-comment-compose-ts">
                      @ {formatTimecode(composeTime)}
                    </div>
                    <div className="mad-comment-compose-row">
                      <input
                        ref={composeInputRef}
                        className="mad-comment-compose-input"
                        placeholder="Add a timed comment…"
                        value={composeText}
                        onFocus={() => {
                          // currentTime now comes from the MediaPlayer (reported via
                          // onCurrentTimeChange → sidebarTimeRef). Round to the nearest
                          // NDF frame boundary (real seconds → frame → NDF seconds).
                          setComposeTime(Math.round(sidebarTimeRef.current * 24000 / 1001) / 24);
                        }}
                        onChange={e => setComposeText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePostComment(); }
                          if (e.key === 'Escape') { setComposeText(''); setComposeError(null); (e.target as HTMLInputElement).blur(); }
                        }}
                      />
                      <button
                        type="button"
                        className="mad-comment-compose-send"
                        onClick={() => void handlePostComment()}
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
                </div>
              )}

              {/* ── Transcription ── */}
              <div className="mad-section">
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

      {/* Phase E: shared deliverable modal for the per-asset "New review link" entry point */}
      {showDeliverableModal && asset && (
        <DeliverableModal
          projectId={projectId}
          availableAssets={[{
            assetId: asset.assetId,
            name: asset.name,
            hasFrameio: Boolean(asset.frameio.assetId || asset.frameio.stackId),
          }]}
          initiallySelectedAssetIds={[asset.assetId]}
          defaultName={`Review — ${asset.name}`}
          onClose={() => setShowDeliverableModal(false)}
          onCreated={() => {
            // Refetch the asset's share link list so the new one appears in
            // the dropdown without waiting for a panel close+reopen. The
            // legacy mirror in deliverable-publish.ts writes asset_share_links
            // so this fetch will see the new row.
            void fetchShareLinks(asset.assetId);
          }}
        />
      )}

      {/* Per-asset custom thumbnail uploader — reuses the batch modal with a 1-item assetIds array.
          The endpoint POSTs the image to Cloudflare Images and patches asset.cloudflare.posterUrl,
          which is what posterPreviewUrl above reads from. */}
      {showThumbModal && asset && (
        <BatchSetThumbnailModal
          projectId={projectId}
          assetIds={[asset.assetId]}
          onClose={() => setShowThumbModal(false)}
          onDone={() => { setShowThumbModal(false); onUpdated(); }}
        />
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
