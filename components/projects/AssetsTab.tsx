'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { AssetPreviewPanel, isPreviewable } from '@/components/projects/AssetPreviewPanel';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DriveAsset {
  entityId:      string;
  driveFileId:   string;
  name:          string;
  mimeType:      string | null;
  webViewLink:   string | null;
  isFolder:      boolean;
  parentDriveId: string | null;
  fileSize:      number | null;
  modifiedAt:    string | null;
  syncedAt:      string;
}

interface TreeNode extends DriveAsset {
  children: TreeNode[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

type FileCategory = 'image' | 'vector' | 'design' | 'pdf' | 'document' | 'video' | 'audio' | 'archive' | 'generic';

// Short labels for Google Workspace native types (no file extension)
const GAPPS_EXT: Record<string, string> = {
  'application/vnd.google-apps.document':     'GDOC',
  'application/vnd.google-apps.spreadsheet':  'SHEET',
  'application/vnd.google-apps.presentation': 'SLIDE',
  'application/vnd.google-apps.form':         'FORM',
  'application/vnd.google-apps.drawing':      'DRAW',
  'application/vnd.google-apps.script':       'APPS',
};

/** Safely extract a display extension from name + mimeType. */
function getExt(name: string, mimeType: string | null): string {
  if (mimeType && GAPPS_EXT[mimeType]) return GAPPS_EXT[mimeType];
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '';
  return name.slice(dot + 1).toUpperCase().slice(0, 5);
}

function getCategory(name: string, mime: string | null): FileCategory {
  // Google Workspace native formats — categorise by specific type
  if (mime === 'application/vnd.google-apps.document')     return 'document';
  if (mime === 'application/vnd.google-apps.spreadsheet')  return 'document';
  if (mime === 'application/vnd.google-apps.presentation') return 'document';
  if (mime?.startsWith('application/vnd.google-apps.'))    return 'generic';

  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'heic'].includes(ext)) return 'image';
  if (['svg', 'ai', 'eps'].includes(ext)) return 'vector';
  if (['psd', 'psb', 'figma', 'sketch', 'xd'].includes(ext)) return 'design';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'].includes(ext)) return 'document';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'aiff'].includes(ext)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'dmg'].includes(ext)) return 'archive';
  return 'generic';
}

const CATEGORY_LABELS: Record<FileCategory, string> = {
  image:    'Image',
  vector:   'Vector',
  design:   'Design',
  pdf:      'PDF',
  document: 'Document',
  video:    'Video',
  audio:    'Audio',
  archive:  'Archive',
  generic:  'File',
};

function buildTree(items: DriveAsset[]): TreeNode[] {
  const byFileId = new Map(items.map((i) => [i.driveFileId, i]));

  function children(parentDriveId: string): TreeNode[] {
    return items
      .filter((i) => i.parentDriveId === parentDriveId)
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((i) => ({ ...i, children: i.isFolder ? children(i.driveFileId) : [] }));
  }

  return items
    .filter((i) => !byFileId.has(i.parentDriveId ?? ''))
    .sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((i) => ({ ...i, children: i.isFolder ? children(i.driveFileId) : [] }));
}

function flattenVisible(nodes: TreeNode[], expanded: Set<string>): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.isFolder && expanded.has(node.driveFileId)) {
      result.push(...flattenVisible(node.children, expanded));
    }
  }
  return result;
}

function matchesFilter(node: TreeNode, text: string, typeFilter: string): boolean {
  if (node.isFolder) return true; // always show folders in filtered view
  const textOk = !text || node.name.toLowerCase().includes(text.toLowerCase());
  const typeOk  = typeFilter === 'all' || getCategory(node.name, node.mimeType) === typeFilter;
  return textOk && typeOk;
}

function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (!node.isFolder) n++;
    else n += countFiles(node.children);
  }
  return n;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke={open ? 'var(--accent)' : 'var(--muted)'} strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none' }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

const CATEGORY_COLORS: Record<FileCategory, string> = {
  image:    '#5bb8d4',
  vector:   '#72b47e',
  design:   '#9b7fd4',
  pdf:      '#d47a5b',
  document: '#6b9fd4',
  video:    '#d49a5b',
  audio:    '#d4bc5b',
  archive:  '#8b9eb0',
  generic:  'var(--muted-soft)',
};

function CategoryIcon({ category }: { category: FileCategory }) {
  switch (category) {
    case 'image': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    );
    case 'vector': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/>
        <line x1="12" y1="2" x2="12" y2="22"/>
        <line x1="2" y1="8.5" x2="22" y2="8.5"/>
        <line x1="2" y1="15.5" x2="22" y2="15.5"/>
      </svg>
    );
    case 'design': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 19l7-7 3 3-7 7-3-3z"/>
        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
        <path d="M2 2l7.586 7.586"/>
        <circle cx="11" cy="11" r="2"/>
      </svg>
    );
    case 'pdf': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h4"/>
      </svg>
    );
    case 'video': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2"/>
      </svg>
    );
    case 'audio': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
    );
    case 'archive': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="21 8 21 21 3 21 3 8"/>
        <rect x="1" y="3" width="22" height="5"/>
        <line x1="10" y1="12" x2="14" y2="12"/>
      </svg>
    );
    case 'document': return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="9" y1="13" x2="15" y2="13"/>
        <line x1="9" y1="17" x2="13" y2="17"/>
      </svg>
    );
    default: return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h6"/>
      </svg>
    );
  }
}

function PresentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/>
      <polyline points="8 21 12 17 16 21"/>
      <line x1="12" y1="17" x2="12" y2="3"/>
    </svg>
  );
}

function SendToScriptsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="13" y2="13"/>
      <polyline points="10 10 13 13 10 16"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// ── Rename input ──────────────────────────────────────────────────────────────

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  return (
    <input
      ref={ref}
      className="assets-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => { if (value.trim() && value !== initial) onCommit(value.trim()); else onCancel(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (value.trim()) onCommit(value.trim()); }
        if (e.key === 'Escape') onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const SENDABLE_EXTS = new Set(['.pdf', '.doc', '.docx', '.txt']);

function isSendableToScripts(asset: DriveAsset): boolean {
  if (asset.isFolder) return false;
  if (asset.mimeType === 'application/vnd.google-apps.document') return true;
  const ext = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase();
  return SENDABLE_EXTS.has(ext);
}

export function AssetsTab({ projectId, sentScriptIds = new Set(), onSendToScripts }: { projectId: string; sentScriptIds?: Set<string>; onSendToScripts?: (asset: DriveAsset) => void }) {
  const [items,      setItems]      = useState<DriveAsset[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const [syncing,          setSyncing]          = useState(false);
  const [previewAsset,     setPreviewAsset]     = useState<DriveAsset | null>(null);
  const [presentingId,     setPresentingId]     = useState<string | null>(null);
  const [presentedId,      setPresentedId]      = useState<string | null>(null);
  const [sendingScriptId,  setSendingScriptId]  = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/assets`);
      const data = await res.json() as { assets?: DriveAsset[]; error?: string };
      if (data.error) throw new Error(data.error);
      setItems(data.assets ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await fetch(`/api/projects/${projectId}/assets/sync`, { method: 'POST' });
      await load();
    } finally {
      setSyncing(false);
    }
  }, [projectId, load]);

  // On mount: pull latest Drive changes, then load
  useEffect(() => { void sync(); }, [sync]);

  // Live updates — re-fetch when Drive syncs a new asset for this project
  useEffect(() => {
    const socket = io('/', { transports: ['websocket'] });
    socket.on('drive:file-synced', (payload: { entityType: string; projectId: string }) => {
      if (payload.projectId === projectId && payload.entityType === 'asset') {
        void load();
      }
    });
    return () => { socket.disconnect(); };
  }, [projectId, load]);

  // ── Tree + filter ───────────────────────────────────────────────────────────

  const tree     = buildTree(items);
  const isFiltering = filterText !== '' || filterType !== 'all';

  // In filtered mode, flatten everything and apply filter to files
  const visibleNodes: TreeNode[] = isFiltering
    ? items
        .filter((i) => matchesFilter({ ...i, children: [] }, filterText, filterType))
        .map((i) => ({ ...i, children: [] }))
    : flattenVisible(tree, expanded);

  function toggleFolder(driveFileId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(driveFileId)) next.delete(driveFileId);
      else next.add(driveFileId);
      return next;
    });
  }

  // ── Rename ──────────────────────────────────────────────────────────────────

  async function commitRename(entityId: string, newName: string) {
    setRenamingId(null);
    setItems((prev) => prev.map((i) => i.entityId === entityId ? { ...i, name: newName } : i));
    try {
      await fetch(`/api/projects/${projectId}/assets/${entityId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName }),
      });
    } catch {
      // Revert on failure
      void load();
    }
  }

  // ── Download ────────────────────────────────────────────────────────────────

  function isPresentable(asset: DriveAsset): boolean {
    if (asset.isFolder) return false;
    const mime = asset.mimeType ?? '';
    const ext  = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase();
    return (
      mime === 'application/vnd.google-apps.presentation' ||
      ['.pptx', '.ppt', '.odp', '.pdf'].includes(ext)
    );
  }

  async function handlePresent(asset: DriveAsset) {
    setPresentingId(asset.entityId);
    setPresentedId(null);
    try {
      const res  = await fetch('/api/presentation/from-drive', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ projectId, entityId: asset.entityId }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to load presentation');
      }
      setPresentedId(asset.entityId);
      // Clear the "loaded" indicator after 3 s
      setTimeout(() => setPresentedId((prev) => prev === asset.entityId ? null : prev), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPresentingId(null);
    }
  }

  function handleDownload(asset: DriveAsset) {
    const a = document.createElement('a');
    a.href  = `/api/projects/${projectId}/assets/${asset.entityId}/download`;
    a.download = asset.name;
    a.click();
  }

  async function handleSendToScripts(asset: DriveAsset) {
    setSendingScriptId(asset.entityId);
    try {
      const res = await fetch(`/api/projects/${projectId}/scripts/from-asset`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ assetId: asset.entityId }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to send to Scripts');
      }
      onSendToScripts?.(asset);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSendingScriptId(null);
    }
  }

  // ── Depth for indentation ───────────────────────────────────────────────────

  function getDepth(node: DriveAsset): number {
    if (isFiltering) return 0;
    let depth = 0;
    let current: DriveAsset | undefined = node;
    const byFileId = new Map(items.map((i) => [i.driveFileId, i]));
    while (current?.parentDriveId && byFileId.has(current.parentDriveId)) {
      depth++;
      current = byFileId.get(current.parentDriveId);
    }
    return depth;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="assets-tab"><p className="assets-empty">Loading assets…</p></div>;
  }

  if (error) {
    return (
      <div className="assets-tab">
        <p className="assets-empty" style={{ color: '#d87070' }}>
          {error}
          {error.includes('Drive') ? ' — check Drive configuration in Settings.' : ''}
        </p>
      </div>
    );
  }

  const fileCount = items.filter((i) => !i.isFolder).length;

  return (
    <div className="assets-tab">
      {/* Filter bar */}
      <div className="assets-filter-bar">
        <select
          className="assets-filter-select"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="all">All types</option>
          <option value="image">Images</option>
          <option value="vector">Vector</option>
          <option value="design">Design</option>
          <option value="pdf">PDF</option>
          <option value="document">Documents</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="archive">Archive</option>
        </select>
        <input
          className="assets-filter-input"
          type="text"
          placeholder="Search assets…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <span className="assets-count">{fileCount} file{fileCount !== 1 ? 's' : ''}</span>
        <button
          type="button"
          className="assets-refresh-btn"
          onClick={() => void sync()}
          disabled={syncing}
          title="Sync with Drive"
        >
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transition: 'transform 0.6s', transform: syncing ? 'rotate(360deg)' : 'none' }}
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div className="assets-empty">
          <p>No assets yet.</p>
          <p style={{ fontSize: '0.82rem' }}>
            Drop files into the <strong>Assets</strong> folder for this project in Google Drive.
          </p>
        </div>
      )}

      {/* File list */}
      {visibleNodes.length > 0 && (
        <div className="ca-asset-list">
          {visibleNodes.map((node) => {
            const depth   = getDepth(node);
            const indent  = depth * 20;
            const isOpen  = expanded.has(node.driveFileId);
            const childCount = node.isFolder ? countFiles(node.children) : 0;

            if (node.isFolder) {
              return (
                <div
                  key={node.entityId}
                  className={`assets-folder-row${isOpen ? ' assets-folder-row--open' : ''}`}
                  style={{ paddingLeft: 14 + indent, position: 'relative' }}
                  onClick={() => toggleFolder(node.driveFileId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleFolder(node.driveFileId); }}
                >
                  {depth > 0 && Array.from({ length: depth }, (_, i) => (
                    <span key={i} className="assets-indent-guide" style={{ left: 14 + i * 20 + 10 }} />
                  ))}
                  <ChevronIcon open={isOpen} />
                  <FolderIcon  open={isOpen} />
                  <span className="assets-folder-name">{node.name}</span>
                  <span className="assets-folder-count">{childCount} file{childCount !== 1 ? 's' : ''}</span>
                  <span className="proj-file-date">{formatDate(node.modifiedAt ?? node.syncedAt)}</span>
                </div>
              );
            }

            const cat         = getCategory(node.name, node.mimeType);
            const label       = CATEGORY_LABELS[cat];
            const color       = CATEGORY_COLORS[cat];
            const canPreview  = isPreviewable(node);

            return (
              <div
                key={node.entityId}
                className={`ca-asset-row${canPreview ? ' ca-asset-row--previewable' : ''}`}
                style={{ paddingLeft: 14 + indent, position: 'relative' }}
                onClick={canPreview ? () => setPreviewAsset(node) : undefined}
                role={canPreview ? 'button' : undefined}
                tabIndex={canPreview ? 0 : undefined}
                onKeyDown={canPreview ? (e) => { if (e.key === 'Enter' || e.key === ' ') setPreviewAsset(node); } : undefined}
              >
                {depth > 0 && Array.from({ length: depth }, (_, i) => (
                  <span key={i} className="assets-indent-guide" style={{ left: 14 + i * 20 + 10 }} />
                ))}
                <div className="ca-asset-icon" style={{ color }}>
                  <CategoryIcon category={cat} />
                </div>

                <div className="ca-asset-info">
                  {renamingId === node.entityId ? (
                    <RenameInput
                      initial={node.name}
                      onCommit={(v) => void commitRename(node.entityId, v)}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <span
                      className="ca-asset-name"
                      onDoubleClick={() => setRenamingId(node.entityId)}
                      title="Double-click to rename"
                    >
                      {node.name}
                    </span>
                  )}
                  <span className="ca-asset-meta">
                    <span
                      className="ca-asset-badge"
                      style={{ color, borderColor: `${color}44`, background: `${color}12` }}
                    >
                      {label}
                    </span>
                    {node.fileSize ? <span>{formatBytes(node.fileSize)}</span> : null}
                    {node.fileSize ? <span>·</span> : null}
                    <span>{formatDate(node.modifiedAt ?? node.syncedAt)}</span>
                  </span>
                </div>

                <div className="ca-asset-actions">
                  {isPresentable(node) && (
                    <button
                      type="button"
                      className={`ca-asset-btn ca-asset-btn--present${presentedId === node.entityId ? ' ca-asset-btn--sent' : ''}`}
                      title={presentedId === node.entityId ? 'Loaded into presentation' : 'Load into presentation'}
                      disabled={presentingId === node.entityId}
                      onClick={(e) => { e.stopPropagation(); void handlePresent(node); }}
                    >
                      {presentingId === node.entityId
                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
                        : presentedId === node.entityId
                          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : <PresentIcon />
                      }
                    </button>
                  )}
                  {isSendableToScripts(node) && (
                    <button
                      type="button"
                      className={`ca-asset-btn${sentScriptIds.has(node.entityId) ? ' ca-asset-btn--sent' : ''}`}
                      title={sentScriptIds.has(node.entityId) ? 'Sent to Scripts' : 'Send to Scripts'}
                      disabled={sendingScriptId === node.entityId || sentScriptIds.has(node.entityId)}
                      onClick={(e) => { e.stopPropagation(); void handleSendToScripts(node); }}
                    >
                      {sendingScriptId === node.entityId
                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
                        : sentScriptIds.has(node.entityId)
                          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : <SendToScriptsIcon />
                      }
                    </button>
                  )}
                  {node.webViewLink && (
                    <a
                      href={node.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ca-asset-btn"
                      title="Open in Drive"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLinkIcon />
                    </a>
                  )}
                  <button
                    type="button"
                    className="ca-asset-btn"
                    title="Download"
                    onClick={(e) => { e.stopPropagation(); handleDownload(node); }}
                  >
                    <DownloadIcon />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isFiltering && visibleNodes.filter((n) => !n.isFolder).length === 0 && items.length > 0 && (
        <p className="assets-empty">No files match your filter.</p>
      )}

      <AssetPreviewPanel
        asset={previewAsset}
        projectId={projectId}
        onClose={() => setPreviewAsset(null)}
      />
    </div>
  );
}
