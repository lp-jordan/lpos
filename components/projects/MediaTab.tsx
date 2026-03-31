'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { io } from 'socket.io-client';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { MediaDetailPanel } from '@/components/media/MediaDetailPanel';
import { SharesPanel } from '@/components/projects/SharesPanel';
import { useContextMenu } from '@/contexts/ContextMenuContext';
import { useToast } from '@/contexts/ToastContext';
import { useVersionConfirm } from '@/contexts/VersionConfirmContext';
import { useIngestQueue } from '@/hooks/useIngestQueue';
import type { MediaAsset } from '@/lib/models/media-asset';
import { LEADERPASS_STATUS_LABEL } from '@/lib/models/media-asset';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mirrors the server-side normalizeAssetKey: strip extension, uppercase, alphanumeric only. */
function normalizeKey(s: string): string {
  return s.replace(/\.[^/.]+$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatBytes(b: number | null): string {
  if (b === null) return '—';
  if (b < 1024)        return `${b} B`;
  if (b < 1024 ** 2)   return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)   return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

type SortField = 'name' | 'date' | 'size' | 'duration';
type SortDir = 'asc' | 'desc';

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'name',     label: 'Name' },
  { value: 'date',     label: 'Date' },
  { value: 'size',     label: 'Size' },
  { value: 'duration', label: 'Duration' },
];

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function sortAssets(assets: MediaAsset[], field: SortField, dir: SortDir): MediaAsset[] {
  const sorted = [...assets].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
        break;
      case 'date':
        cmp = a.registeredAt.localeCompare(b.registeredAt);
        break;
      case 'size':
        cmp = (a.fileSize ?? 0) - (b.fileSize ?? 0);
        break;
      case 'duration':
        cmp = (a.duration ?? 0) - (b.duration ?? 0);
        break;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

// ── Status badges ─────────────────────────────────────────────────────────────

function TranscriptionBadge({ status }: { status: MediaAsset['transcription']['status'] }) {
  const map: Record<typeof status, [string, string]> = {
    none:       ['ma-badge--neutral',  'Not Transcribed'],
    queued:     ['ma-badge--pending',  'Queued'],
    processing: ['ma-badge--active',   'Transcribing…'],
    done:       ['ma-badge--success',  'Transcribed'],
    failed:     ['ma-badge--error',    'Failed'],
  };
  const [cls, label] = map[status];
  return <span className={`ma-badge ${cls}`}>{label}</span>;
}

const VERSION_COLORS = [
  { bg: 'rgba(100,149,237,0.15)', color: '#6495ed' }, // v1 — cornflower blue
  { bg: 'rgba(155,122,204,0.15)', color: '#9b7acc' }, // v2 — soft purple
  { bg: 'rgba(74,184,193,0.15)',  color: '#4ab8c1' }, // v3 — teal
  { bg: 'rgba(219,175,95,0.16)',  color: '#dbaf5f' }, // v4 — gold (accent)
];

function VersionBadge({ version }: { version: number }) {
  const slot = VERSION_COLORS[(version - 1) % VERSION_COLORS.length];
  return (
    <span
      className="ma-badge ma-badge--version"
      style={{ background: slot.bg, color: slot.color }}
    >
      v{version}
    </span>
  );
}

function LeaderPassBadge({ status }: { status: MediaAsset['leaderpass']['status'] }) {
  const cls: Record<typeof status, string> = {
    none: 'ma-badge--neutral',
    preparing: 'ma-badge--active',
    awaiting_platform: 'ma-badge--review',
    published: 'ma-badge--success',
    failed: 'ma-badge--error',
  };
  return <span className={`ma-badge ${cls[status]}`}>{LEADERPASS_STATUS_LABEL[status]}</span>;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const IconFolderOpen = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
  </svg>
);
const IconFrameIO = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);
const IconRefresh = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
  </svg>
);
const IconTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
  </svg>
);
const IconFileVideo = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <polygon points="10 11 16 14 10 17 10 11"/>
  </svg>
);
const IconUpload = () => (
  <svg className="proj-upload-zone-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);

// ── Asset row ─────────────────────────────────────────────────────────────────

function AssetRow({
  asset,
  isOpen,
  isSelected,
  onSelect,
  onClick,
  onContextMenu,
}: {
  asset:         MediaAsset;
  isOpen:        boolean;
  isSelected:    boolean;
  onSelect:      (e: React.MouseEvent) => void;
  onClick:       () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`ma-row${isOpen ? ' ma-row--open' : ''}${isSelected ? ' ma-row--selected' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      <div className="ma-row-check" onClick={(e) => { e.stopPropagation(); onSelect(e); }}>
        <input
          type="checkbox"
          className="ma-checkbox"
          checked={isSelected}
          onChange={() => {}}
          tabIndex={-1}
          aria-label={`Select ${asset.name}`}
        />
      </div>
      <div className="ma-row-icon"><IconFileVideo /></div>
      <div className="ma-row-main">
        <span className="ma-name">{asset.name}</span>
        {asset.name !== asset.originalFilename && (
          <span className="ma-filename">{asset.originalFilename}</span>
        )}
        {asset.description && <span className="ma-description">{asset.description}</span>}
      </div>
      <div className="ma-row-meta">
        <span className="ma-filesize">{formatBytes(asset.fileSize)}</span>
        <span className="ma-duration">{formatDuration(asset.duration)}</span>
        <span className="ma-date">{formatDate(asset.registeredAt)}</span>
      </div>
      <div className="ma-row-badges">
        <TranscriptionBadge status={asset.transcription.status} />
        <VersionBadge version={asset.frameio.version} />
        <LeaderPassBadge status={asset.leaderpass.status} />
      </div>
      <button
        type="button"
        className="ma-menu-btn"
        onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}
        aria-label="Asset actions"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
        </svg>
      </button>
    </div>
  );
}

// ── Asset card ────────────────────────────────────────────────────────────────

function AssetCard({
  asset,
  isOpen,
  isSelected,
  onSelect,
  onClick,
  onContextMenu,
}: {
  asset:         MediaAsset;
  isOpen:        boolean;
  isSelected:    boolean;
  onSelect:      (e: React.MouseEvent) => void;
  onClick:       () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`ma-card${isOpen ? ' ma-card--open' : ''}${isSelected ? ' ma-card--selected' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      <div className="ma-card-check" onClick={(e) => { e.stopPropagation(); onSelect(e); }}>
        <input
          type="checkbox"
          className="ma-checkbox"
          checked={isSelected}
          onChange={() => {}}
          tabIndex={-1}
          aria-label={`Select ${asset.name}`}
        />
      </div>
      <div className="ma-card-thumb">
        <IconFileVideo />
        {asset.frameio.playerUrl && <span className="ma-card-thumb-badge">Frame.io</span>}
      </div>
      <div className="ma-card-body">
        <div className="ma-card-name">{asset.name}</div>
        {asset.description && <div className="ma-card-desc">{asset.description}</div>}
        <div className="ma-card-meta">{formatBytes(asset.fileSize)} · {formatDuration(asset.duration)} · {formatDate(asset.registeredAt)}</div>
        <div className="ma-card-badges">
          <TranscriptionBadge status={asset.transcription.status} />
          <VersionBadge version={asset.frameio.version} />
          <LeaderPassBadge status={asset.leaderpass.status} />
        </div>
      </div>
      <button
        type="button"
        className="ma-card-menu-btn"
        onClick={(e) => { e.stopPropagation(); onContextMenu(e); }}
        aria-label="Asset actions"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
        </svg>
      </button>
    </div>
  );
}

// ── Main MediaTab ─────────────────────────────────────────────────────────────

export function MediaTab({
  projectId,
  projectName,
  deepLinkedAssetId,
  onGoToTranscript,
}: {
  projectId: string;
  projectName: string;
  deepLinkedAssetId?: string | null;
  onGoToTranscript?: (jobId: string) => void;
}) {
  const [assets,          setAssets]          = useState<MediaAsset[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [viewMode,        setViewMode]        = useState<'list' | 'card'>('list');
  const [search,          setSearch]          = useState('');
  const [sortField,       setSortField]       = useState<SortField>('date');
  const [sortDir,         setSortDir]         = useState<SortDir>('desc');
  const [selectedAsset,   setSelectedAsset]   = useState<MediaAsset | null>(null);
  const [isDragOver,      setIsDragOver]      = useState(false);
  const [uploadError,     setUploadError]     = useState<string | null>(null);
  const [confirmDelete,   setConfirmDelete]   = useState<{ asset: MediaAsset; deleteFile: boolean } | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState<{ deleteFile: boolean } | null>(null);
  const [bulkDeleteWorking, setBulkDeleteWorking] = useState(false);
  const [fioConnected,    setFioConnected]    = useState<boolean | null>(null);
  const [selectedIds,     setSelectedIds]     = useState<Set<string>>(new Set());
  const [showSharesPanel, setShowSharesPanel] = useState(false);
  const [shareResult,     setShareResult]     = useState<{ url: string; count: number; skipped: number } | null>(null);
  const [shareWorking,    setShareWorking]    = useState(false);
  const [shareError,      setShareError]      = useState<string | null>(null);
  const [shareCopied,     setShareCopied]     = useState(false);
  const [publishWorking,  setPublishWorking]  = useState(false);
  const [publishError,    setPublishError]    = useState<string | null>(null);
  const [retranscribeWorking, setRetranscribeWorking] = useState(false);
  const [retranscribeError,   setRetranscribeError]   = useState<string | null>(null);
  const { requestVersionConfirmation, startBatch, endBatch } = useVersionConfirm();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const commentCountsRef = useRef<Map<string, number>>(new Map());
  const hasCommentBaselineRef = useRef(false);
  const consumedDeepLinkRef = useRef<string | null>(null);
const { openMenu } = useContextMenu();
  const { toast } = useToast();
  const { jobs: ingestJobs, cancel: cancelIngestJob } = useIngestQueue();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── Remote ingest state (survives tab navigation) ──────────────────────────

  // Active ingest jobs for this project — used to float uploading assets to the top of the list
  const activeIngestJobs = ingestJobs.filter(
    (j) => j.projectId === projectId && (j.status === 'queued' || j.status === 'ingesting'),
  );

  // ── Frame.io connection status ─────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/auth/frameio/status')
      .then((r) => r.json() as Promise<{ connected: boolean }>)
      .then((d) => setFioConnected(d.connected))
      .catch(() => setFioConnected(false));
  }, []);

  // ── Data ──────────────────────────────────────────────────────────────────

  const fetchAssets = useCallback(async () => {
    try {
      const res  = await fetch(`/api/projects/${projectId}/media`);
      if (!res.ok) return;
      const data = await res.json() as { assets: MediaAsset[] };

      const nextCommentCounts = new Map<string, number>();
      data.assets.forEach((asset) => {
        if (asset.frameio.assetId) nextCommentCounts.set(asset.assetId, asset.frameio.commentCount);
      });

      if (hasCommentBaselineRef.current) {
        data.assets.forEach((asset) => {
          if (!asset.frameio.assetId) return;
          const previousCount = commentCountsRef.current.get(asset.assetId);
          if (previousCount === undefined || asset.frameio.commentCount <= previousCount) return;
          toast({
            id: `comment:${asset.assetId}:${asset.frameio.commentCount}`,
            kind: 'comment',
            tone: 'info',
            title: 'New Comment',
            body: `New comment on ${asset.name} in ${projectName}`,
            projectId,
            assetId: asset.assetId,
          });
        });
      }

      commentCountsRef.current = nextCommentCounts;
      hasCommentBaselineRef.current = true;
      setAssets(data.assets);
      // Keep selectedAsset in sync
      setSelectedAsset((prev) => prev ? (data.assets.find((a) => a.assetId === prev.assetId) ?? null) : null);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [projectId, projectName, toast]);

  useEffect(() => { void fetchAssets(); }, [fetchAssets]);

  useEffect(() => {
    const id = window.setInterval(() => { void fetchAssets(); }, 30_000);
    return () => window.clearInterval(id);
  }, [fetchAssets]);

  useEffect(() => {
    if (!deepLinkedAssetId) return;
    if (consumedDeepLinkRef.current === deepLinkedAssetId) return;
    const match = assets.find((asset) => asset.assetId === deepLinkedAssetId);
    if (!match) return;

    consumedDeepLinkRef.current = deepLinkedAssetId;
    setSelectedAsset(match);
    setShowSharesPanel(false);

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete('assetId');
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [assets, deepLinkedAssetId, pathname, router, searchParams]);

  // Refresh when transcription jobs complete
  useEffect(() => {
    const socket = io('/transcripter', { transports: ['websocket'] });
    socket.on('queue', () => { void fetchAssets(); });
    return () => { socket.disconnect(); };
  }, [fetchAssets]);

  // Refresh whenever Frame.io upload queue changes (catches start + completion)
  useEffect(() => {
    const socket = io('/upload-queue', { transports: ['websocket'] });
    socket.on('queue', () => { void fetchAssets(); });
    return () => { socket.disconnect(); };
  }, [fetchAssets]);

  // ── Upload ────────────────────────────────────────────────────────────────

  const ACCEPTED_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.mxf', '.webm', '.m4v', '.mts', '.mp3', '.wav', '.aac', '.flac'];

  function filterAccepted(files: FileList | File[]): File[] {
    return Array.from(files).filter((f) =>
      ACCEPTED_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
  }

  function findLocalVersionCandidate(filename: string): MediaAsset | undefined {
    const key = normalizeKey(filename);
    if (!key) return undefined;
    return [...assets].reverse().find(
      (a) => normalizeKey(a.name) === key || normalizeKey(a.originalFilename) === key,
    );
  }

  async function reserveIngestJobs(filenames: string[]): Promise<{ filename: string; jobId: string }[]> {
    try {
      const res = await fetch(`/api/projects/${projectId}/ingest-queue/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames }),
      });
      if (!res.ok) return [];
      const data = await res.json() as { jobs?: { filename: string; jobId: string }[] };
      return data.jobs ?? [];
    } catch {
      return [];
    }
  }

  function uploadFile(
    file: File,
    replaceAssetId?: string,
    reservedJobId?: string,
  ): Promise<{
    ok: boolean;
    code?: string;
    error?: string;
    existingAsset?: MediaAsset;
    currentVersionNumber?: number;
  }> {
    return new Promise((resolve) => {
      const form = new FormData();
      if (replaceAssetId) form.append('replaceAssetId', replaceAssetId);
      form.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { resolve({ ok: true }); return; }
        try {
          const d = JSON.parse(xhr.responseText) as {
            error?: string;
            code?: string;
            existingAsset?: MediaAsset;
            currentVersionNumber?: number;
          };
          resolve({
            ok: false,
            error: d.error ?? `Upload failed for "${file.name}"`,
            code: d.code,
            existingAsset: d.existingAsset,
            currentVersionNumber: d.currentVersionNumber,
          });
        } catch {
          resolve({ ok: false, error: `Upload failed for "${file.name}"` });
        }
      };
      xhr.onerror = () => { resolve({ ok: false, error: `Network error uploading "${file.name}"` }); };
      xhr.open('POST', `/api/projects/${projectId}/media`);
      xhr.setRequestHeader('x-upload-filename', encodeURIComponent(file.name));
      if (reservedJobId) xhr.setRequestHeader('x-ingest-job-id', reservedJobId);
      xhr.send(form);
    });
  }

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setUploadError(null);
    startBatch();

    // Warn the user if they try to leave while uploads are in progress.
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    try {
      // Pre-check: detect version candidates by name before any upload starts.
      // Shows the confirmation modal immediately at drag-and-drop time rather than
      // waiting for each file to finish uploading and hash before asking.
      // Map of fileIndex → replaceAssetId (confirmed) or null (declined).
      const replaceMap = new Map<number, string | null>();
      for (let i = 0; i < files.length; i++) {
        const candidate = findLocalVersionCandidate(files[i].name);
        if (candidate) {
          const confirmed = await requestVersionConfirmation(
            candidate,
            candidate.frameio?.version ?? 1,
          );
          replaceMap.set(i, confirmed ? candidate.assetId : null);
        }
      }

      // Pre-reserve ingest queue entries for all files so every file appears as
      // "queued" in the IngestTray immediately — before any upload has started.
      const reserved = await reserveIngestJobs(files.map((f) => f.name));

      for (let i = 0; i < files.length; i++) {
        const reservedJobId = reserved[i]?.jobId;
        // Skip files whose reserved queue slot was cancelled while waiting.
        if (reservedJobId && ingestJobs.some((j) => j.jobId === reservedJobId && j.status === 'cancelled')) {
          continue;
        }

        // If pre-checked, upload directly with or without replaceAssetId
        if (replaceMap.has(i)) {
          const replaceId = replaceMap.get(i);
          if (replaceId === null) {
            // User declined the version bump — cancel the reserved slot and skip
            if (reservedJobId) cancelIngestJob(reservedJobId);
            continue;
          }
          const result = await uploadFile(files[i], replaceId, reservedJobId);
          if (!result.ok) setUploadError(result.error ?? `Upload failed for "${files[i].name}"`);
          continue;
        }

        const firstAttempt = await uploadFile(files[i], undefined, reservedJobId);
        if (firstAttempt.ok) continue;

        // Fallback: server detected a version conflict that the pre-check missed
        // (e.g., a concurrent upload registered an asset between pre-check and upload).
        if (firstAttempt.code === 'version_confirmation_required' && firstAttempt.existingAsset) {
          const confirmed = await requestVersionConfirmation(
            firstAttempt.existingAsset,
            firstAttempt.currentVersionNumber ?? firstAttempt.existingAsset.frameio.version ?? 1,
          );
          if (confirmed) {
            // Retry without reservedJobId — the first attempt already consumed or failed it
            const retry = await uploadFile(files[i], firstAttempt.existingAsset.assetId);
            if (!retry.ok) setUploadError(retry.error ?? `Upload failed for "${files[i].name}"`);
          }
          continue;
        }

        setUploadError(firstAttempt.error ?? `Upload failed for "${files[i].name}"`);
      }
      void fetchAssets();
    } finally {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      endBatch();
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = filterAccepted(e.target.files ?? new FileList());
    if (files.length) void uploadFiles(files);
    e.target.value = '';
  }

  function handleDragOver(e: React.DragEvent)  { e.preventDefault(); setIsDragOver(true); }
  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  }

  /**
   * Convert a file:// URI to an absolute OS path.
   * Handles both local paths (file:///C:/…) and UNC paths (file://server/share/…).
   */
  function fileUriToPath(uri: string): string {
    if (!uri.startsWith('file://')) return uri;
    const withoutScheme = uri.slice(7); // strip 'file://'
    if (withoutScheme.startsWith('/')) {
      // Local: file:///C:/path/file.mp4 → C:\path\file.mp4
      return decodeURIComponent(withoutScheme.slice(1)).replace(/\//g, '\\');
    }
    // UNC: file://server/share/path → \\server\share\path
    return '\\\\' + decodeURIComponent(withoutScheme).replace(/\//g, '\\');
  }

  async function registerPaths(paths: string[]) {
    setUploadError(null);
    for (let i = 0; i < paths.length; i++) {
      try {
        const registerPath = async (replaceAssetId?: string) => fetch(`/api/projects/${projectId}/media/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: paths[i], replaceAssetId }),
        });

        let res = await registerPath();
        if (!res.ok) {
          const d = await res.json() as {
            error?: string;
            code?: string;
            existingAsset?: MediaAsset;
            currentVersionNumber?: number;
          };
          if (d.code === 'version_confirmation_required' && d.existingAsset) {
            const confirmed = await requestVersionConfirmation(
              d.existingAsset,
              d.currentVersionNumber ?? d.existingAsset.frameio.version ?? 1,
            );
            if (confirmed) {
              res = await registerPath(d.existingAsset.assetId);
              if (res.ok) continue;
              const retry = await res.json() as { error?: string };
              setUploadError(retry.error ?? `Failed to register "${paths[i]}"`);
              continue;
            }
            continue;
          }
          setUploadError(d.error ?? `Failed to register "${paths[i]}"`);
        }
      } catch {
        setUploadError(`Network error registering "${paths[i]}"`);
      }
    }
    void fetchAssets();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);

    // ── Path detection (Windows Explorer drag) ──────────────────────────────
    // Explorer provides file:// URIs in text/uri-list. Detect and register
    // in place so large NAS files are never copied into the app.
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      const paths = uriList
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#') && s.startsWith('file://'))
        .map(fileUriToPath)
        .filter((p) => ACCEPTED_EXTS.some((ext) => p.toLowerCase().endsWith(ext)));

      if (paths.length) {
        void registerPaths(paths);
        return;
      }
    }

    // ── Fallback: browser-originated drag (no path info) ────────────────────
    const files = filterAccepted(e.dataTransfer.files);
    if (files.length) void uploadFiles(files);
  }

  function toggleSelect(assetId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  // ── Context menu ──────────────────────────────────────────────────────────

  function openAssetMenu(e: React.MouseEvent, asset: MediaAsset) {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      {
        type: 'item' as const,
        label: 'Open Details',
        icon: <IconFileVideo />,
        onClick: () => setSelectedAsset(asset),
      },
      { type: 'separator' as const },
      {
        type: 'item' as const,
        label: 'Open File Location',
        icon: <IconFolderOpen />,
        disabled: !asset.filePath,
        onClick: async () => {
          await fetch(`/api/projects/${projectId}/media/${asset.assetId}/open-location`, { method: 'POST' });
        },
      },
      { type: 'separator' as const },
      {
        type: 'item' as const,
        label: asset.frameio.status === 'none' ? 'Upload to Frame.io' : 'Frame.io Uploaded',
        icon: <IconFrameIO />,
        disabled: asset.frameio.status !== 'none' || !asset.filePath,
        onClick: async () => {
          await fetch(`/api/projects/${projectId}/media/${asset.assetId}/frameio`, { method: 'POST' });
          void fetchAssets();
        },
      },
      {
        type: 'item' as const,
        label: asset.leaderpass.status === 'none' ? 'Push to LeaderPass' : LEADERPASS_STATUS_LABEL[asset.leaderpass.status],
        icon: <IconFrameIO />,
        disabled: !asset.filePath || asset.leaderpass.status === 'preparing',
        onClick: async () => {
          await fetch(`/api/projects/${projectId}/media/${asset.assetId}/leaderpass`, { method: 'POST' });
          void fetchAssets();
        },
      },
      { type: 'separator' as const },
      {
        type: 'item' as const,
        label: 'Re-transcribe',
        icon: <IconRefresh />,
        disabled: !asset.filePath || asset.transcription.status === 'queued' || asset.transcription.status === 'processing',
        onClick: async () => {
          await fetch(`/api/projects/${projectId}/media/${asset.assetId}/retranscribe`, { method: 'POST' });
          void fetchAssets();
        },
      },
      { type: 'separator' as const },
      ...(asset.storageType === 'uploaded' ? [{
        type: 'item' as const,
        label: 'Delete File',
        icon: <IconTrash />,
        danger: true,
        onClick: () => setConfirmDelete({ asset, deleteFile: true }),
      }] : []),
      {
        type: 'item' as const,
        label: 'Remove from Project',
        icon: <IconTrash />,
        danger: true,
        onClick: () => setConfirmDelete({ asset, deleteFile: false }),
      },
    ]);
  }

  // ── Filtered list ─────────────────────────────────────────────────────────

  const filtered = assets.filter((a) =>
    !search || a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.originalFilename.toLowerCase().includes(search.toLowerCase()),
  );

  // Active ingest jobs keyed by filename for fast lookup
  const activeIngestByFilename = new Map(activeIngestJobs.map((j) => [j.filename, j]));

  // Sort: assets with active ingest jobs float to the top (most progress first),
  // remaining assets keep the user's chosen order.
  const _baseSorted = sortAssets(filtered, sortField, sortDir);
  const sorted = activeIngestByFilename.size === 0 ? _baseSorted : (() => {
    const active: MediaAsset[] = [];
    const rest: MediaAsset[] = [];
    for (const a of _baseSorted) {
      if (activeIngestByFilename.has(a.name) || activeIngestByFilename.has(a.originalFilename)) {
        active.push(a);
      } else {
        rest.push(a);
      }
    }
    active.sort((a, b) => {
      const pa = (activeIngestByFilename.get(a.name) ?? activeIngestByFilename.get(a.originalFilename))?.progress ?? 0;
      const pb = (activeIngestByFilename.get(b.name) ?? activeIngestByFilename.get(b.originalFilename))?.progress ?? 0;
      return pb - pa;
    });
    return [...active, ...rest];
  })();

  // ── Selection helpers (depend on filtered) ────────────────────────────────

  const allFilteredIds = sorted.map((a) => a.assetId);
  const allSelected    = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedIds.has(id));
  const someSelected   = !allSelected && allFilteredIds.some((id) => selectedIds.has(id));

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(allFilteredIds));
  }

  async function handleBulkDelete(deleteFile: boolean) {
    if (!selectedIds.size) return;
    setBulkDeleteWorking(true);
    const ids = [...selectedIds];
    await Promise.all(
      ids.map((id) =>
        fetch(`/api/projects/${projectId}/media/${id}?deleteFile=${deleteFile}`, { method: 'DELETE' }),
      ),
    );
    if (selectedAsset && ids.includes(selectedAsset.assetId)) setSelectedAsset(null);
    setSelectedIds(new Set());
    setConfirmBulkDelete(null);
    setBulkDeleteWorking(false);
    await fetchAssets();
  }

  async function handleBulkShare() {
    if (!selectedIds.size) return;
    setShareWorking(true);
    setShareError(null);
    setShareResult(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/media/share`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ assetIds: [...selectedIds] }),
      });
      const data = await res.json() as { shareUrl?: string; fileCount?: number; skipped?: number; error?: string };
      if (!res.ok) { setShareError(data.error ?? 'Failed to create share link'); return; }
      if (data.shareUrl) {
        setShareResult({ url: data.shareUrl, count: data.fileCount ?? selectedIds.size, skipped: data.skipped ?? 0 });
      }
    } catch {
      setShareError('Network error — could not create share link');
    } finally {
      setShareWorking(false);
    }
  }

  async function handleBulkLeaderPassPublish() {
    if (!selectedIds.size) return;
    setPublishWorking(true);
    setPublishError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/media/leaderpass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [...selectedIds] }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setPublishError(data.error ?? 'Failed to queue LeaderPass publish');
        return;
      }
      setSelectedIds(new Set());
      void fetchAssets();
    } catch {
      setPublishError('Network error — could not queue LeaderPass publish');
    } finally {
      setPublishWorking(false);
    }
  }

  async function handleBulkRetranscribe() {
    if (!selectedIds.size) return;
    setRetranscribeWorking(true);
    setRetranscribeError(null);
    try {
      await Promise.all(
        [...selectedIds].map((id) =>
          fetch(`/api/projects/${projectId}/media/${id}/retranscribe`, { method: 'POST' }),
        ),
      );
      setSelectedIds(new Set());
      void fetchAssets();
    } catch {
      setRetranscribeError('Network error — could not queue re-transcription');
    } finally {
      setRetranscribeWorking(false);
    }
  }

  function handleCopyShareUrl() {
    if (!shareResult) return;
    navigator.clipboard.writeText(shareResult.url).catch(() => {});
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="proj-tab-content page-stack">

        {/* Frame.io connection banner */}
        {fioConnected === false && (
          <div className="ma-fio-connect-banner">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Frame.io is not connected — uploads will fail until you authenticate.</span>
            <a
              href="/api/auth/frameio/connect"
              className="ma-fio-connect-btn"
            >
              Connect Frame.io
            </a>
          </div>
        )}

        {/* Drop zone */}
        <div
          className={`proj-upload-zone${isDragOver ? ' proj-upload-zone--active' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          aria-label="Upload media — click or drag files here"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
        >
          {isDragOver ? (
            <span className="proj-upload-zone-label proj-upload-zone-label--drop">Drop to upload</span>
          ) : (
            <>
              <IconUpload />
              <span className="proj-upload-zone-label">
                Drag files here or <span className="proj-upload-zone-link">click to browse</span>
              </span>
              <span className="proj-upload-zone-hint">Drag from Explorer to register in place · or click to browse</span>
            </>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden="true"
        />

        {uploadError && (
          <p className="m-upload-feedback m-upload-feedback--error">
            {uploadError}
            <button type="button" onClick={() => setUploadError(null)}>✕</button>
          </p>
        )}

        {/* Toolbar */}
        {assets.length > 0 && (
          <div className="ma-toolbar">
            <div className="ma-select-all-wrap">
              <input
                type="checkbox"
                className="ma-checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected; }}
                onChange={toggleSelectAll}
                aria-label="Select all"
                title="Select all"
              />
            </div>
            <input
              className="proj-search"
              type="text"
              placeholder="Search media…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="ma-sort-controls">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`ma-sort-btn${sortField === opt.value ? ' ma-sort-btn--active' : ''}`}
                  onClick={() => {
                    if (sortField === opt.value) {
                      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                    } else {
                      setSortField(opt.value);
                      setSortDir(opt.value === 'name' ? 'asc' : 'desc');
                    }
                  }}
                >
                  {opt.label}
                  {sortField === opt.value && (
                    <span className="ma-sort-arrow">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="ma-toolbar-right">
              <button
                type="button"
                className={`ma-shares-btn${showSharesPanel ? ' ma-shares-btn--active' : ''}`}
                onClick={() => { setShowSharesPanel((v) => !v); if (!showSharesPanel) setSelectedAsset(null); }}
                title="Share links"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
                Shares
              </button>
              <div className="m-view-toggle">
                <button className={`m-view-btn${viewMode === 'list' ? ' active' : ''}`} type="button"
                  onClick={() => setViewMode('list')} aria-label="List view">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                  </svg>
                </button>
                <button className={`m-view-btn${viewMode === 'card' ? ' active' : ''}`} type="button"
                  onClick={() => setViewMode('card')} aria-label="Card view">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Selection action bar */}
        {selectedIds.size > 0 && (
          <div className="ma-selection-bar">
            <span className="ma-selection-count">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => void handleBulkLeaderPassPublish()}
              disabled={publishWorking}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
              </svg>
              {publishWorking ? 'Queueing publish...' : 'Push to LeaderPass'}
            </button>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => void handleBulkShare()}
              disabled={shareWorking}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              {shareWorking ? 'Creating share…' : 'Create Share Link'}
            </button>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => void handleBulkRetranscribe()}
              disabled={retranscribeWorking}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
              </svg>
              {retranscribeWorking ? 'Queueing…' : 'Re-transcribe'}
            </button>
            {publishError && <span className="ma-selection-error">{publishError}</span>}
            {shareError && <span className="ma-selection-error">{shareError}</span>}
            {retranscribeError && <span className="ma-selection-error">{retranscribeError}</span>}
            <button
              type="button"
              className="ma-selection-action ma-selection-action--danger"
              onClick={() => setConfirmBulkDelete({ deleteFile: false })}
              disabled={bulkDeleteWorking}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
              Remove Selected
            </button>
            <button
              type="button"
              className="ma-selection-action ma-selection-action--danger"
              onClick={() => setConfirmBulkDelete({ deleteFile: true })}
              disabled={bulkDeleteWorking}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
              Delete Files
            </button>
            <button
              type="button"
              className="ma-selection-clear"
              onClick={() => setSelectedIds(new Set())}
              aria-label="Clear selection"
            >
              ✕ Clear
            </button>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <p className="m-empty">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="m-empty">
            {assets.length === 0
              ? 'No media yet — drag a file from your NAS or click the upload zone above.'
              : 'No assets match your search.'}
          </p>
        ) : viewMode === 'list' ? (
          <div className="ma-list">
            {sorted.map((a) => (
              <AssetRow
                key={a.assetId}
                asset={a}
                isOpen={selectedAsset?.assetId === a.assetId}
                isSelected={selectedIds.has(a.assetId)}
                onSelect={() => toggleSelect(a.assetId)}
                onClick={() => { setSelectedAsset((prev) => prev?.assetId === a.assetId ? null : a); setShowSharesPanel(false); }}
                onContextMenu={(e) => openAssetMenu(e, a)}
              />
            ))}
          </div>
        ) : (
          <div className="ma-grid">
            {sorted.map((a) => (
              <AssetCard
                key={a.assetId}
                asset={a}
                isOpen={selectedAsset?.assetId === a.assetId}
                isSelected={selectedIds.has(a.assetId)}
                onSelect={() => toggleSelect(a.assetId)}
                onClick={() => { setSelectedAsset((prev) => prev?.assetId === a.assetId ? null : a); setShowSharesPanel(false); }}
                onContextMenu={(e) => openAssetMenu(e, a)}
              />
            ))}
          </div>
        )}

      </div>

      {/* Detail panel */}
      <MediaDetailPanel
        asset={selectedAsset}
        projectId={projectId}
        onClose={() => setSelectedAsset(null)}
        onUpdated={fetchAssets}
        onGoToTranscript={onGoToTranscript}
      />

      {/* Shares panel */}
      <SharesPanel
        projectId={projectId}
        assets={assets}
        open={showSharesPanel}
        onClose={() => setShowSharesPanel(false)}
      />

      {/* Share result modal */}
      {shareResult && (
        <div className="ma-share-modal-backdrop" onClick={() => setShareResult(null)} aria-hidden="true">
          <div className="ma-share-modal" role="dialog" aria-label="Share link ready" onClick={(e) => e.stopPropagation()}>
            <div className="ma-share-modal-header">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              <span>Share link ready</span>
              <button type="button" className="ma-share-modal-close" onClick={() => setShareResult(null)} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <p className="ma-share-modal-desc">
              {shareResult.count} file{shareResult.count !== 1 ? 's' : ''} added to Frame.io presentation
              {shareResult.skipped > 0 && ` (${shareResult.skipped} skipped — not yet on Frame.io)`}.
            </p>
            <div className="ma-share-modal-url-row">
              <span className="ma-share-modal-url">{shareResult.url}</span>
              <button
                type="button"
                className="ma-share-modal-copy-btn"
                onClick={handleCopyShareUrl}
              >
                {shareCopied ? '✓ Copied' : 'Copy link'}
              </button>
            </div>
            <a
              href={shareResult.url}
              target="_blank"
              rel="noreferrer"
              className="ma-share-modal-open-link"
            >
              Open in Frame.io ↗
            </a>
          </div>
        </div>
      )}

      {/* Bulk delete confirm */}
      {confirmBulkDelete && (
        <ConfirmModal
          title={confirmBulkDelete.deleteFile ? 'Delete Files' : 'Remove Selected'}
          body={(() => {
            const n = selectedIds.size;
            const count = `${n} item${n === 1 ? '' : 's'}`;
            return confirmBulkDelete.deleteFile
              ? `Permanently delete ${count} from disk, remove from this project, and delete from Frame.io where applicable? This cannot be undone.`
              : `Remove ${count} from this project? Files on disk and Frame.io are not affected.`;
          })()}
          confirmLabel={bulkDeleteWorking ? (confirmBulkDelete.deleteFile ? 'Deleting…' : 'Removing…') : (confirmBulkDelete.deleteFile ? 'Delete Files' : 'Remove')}
          danger
          onConfirm={() => void handleBulkDelete(confirmBulkDelete.deleteFile)}
          onClose={() => setConfirmBulkDelete(null)}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.deleteFile ? 'Delete File' : 'Remove from Project'}
          body={(() => {
            const name = confirmDelete.asset.name;
            const hasFio = !!confirmDelete.asset.frameio?.assetId;
            const fioNote = hasFio ? ' It will also be permanently deleted from Frame.io.' : '';
            return confirmDelete.deleteFile
              ? `Permanently delete "${name}" from disk and remove it from this project?${fioNote} This cannot be undone.`
              : `Remove "${name}" from this project? The file on disk is not affected.${fioNote}`;
          })()}
          confirmLabel={confirmDelete.deleteFile ? 'Delete File' : 'Remove'}
          danger
          onConfirm={async () => {
            await fetch(
              `/api/projects/${projectId}/media/${confirmDelete.asset.assetId}?deleteFile=${confirmDelete.deleteFile}`,
              { method: 'DELETE' },
            );
            if (selectedAsset?.assetId === confirmDelete.asset.assetId) setSelectedAsset(null);
            await fetchAssets();
            setConfirmDelete(null);
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}

    </>
  );
}
