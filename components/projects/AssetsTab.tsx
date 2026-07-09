'use client';

import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { io } from 'socket.io-client';
import { AssetPreviewPanel, isPreviewable } from '@/components/projects/AssetPreviewPanel';
import { LinkGroupManagementModal } from '@/components/projects/LinkGroupManagementModal';
import { ConfirmModal } from '@/components/shared/ConfirmModal';

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

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
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

export function AssetsTab({ projectId, projectName = '', sentScriptIds = new Set(), onSendToScripts }: { projectId: string; projectName?: string; sentScriptIds?: Set<string>; onSendToScripts?: (asset: DriveAsset) => void }) {
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

  const [uploading,      setUploading]      = useState(false);
  const [uploadError,    setUploadError]    = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [newFolderMode,  setNewFolderMode]  = useState(false);
  const [newFolderName,  setNewFolderName]  = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const newFolderRef  = useRef<HTMLInputElement>(null);
  const uploadInputId = useId();

  const [lock, setLock] = useState<{ locked: boolean; reason?: string; jobId?: string; jobFailed?: boolean } | null>(null);
  const [showManageModal, setShowManageModal] = useState(false);
  const [linkGroup, setLinkGroup] = useState<{
    groupId: string;
    sharedFolderName: string | undefined;
    linkedProjects: { projectId: string; name: string }[];
  } | null>(null);

  const [assetsFolderDriveId, setAssetsFolderDriveId] = useState<string | null>(null);
  const [selectedIds,    setSelectedIds]    = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [showMoveModal,  setShowMoveModal]  = useState(false);
  const [moving,         setMoving]         = useState(false);
  const [zipping,        setZipping]        = useState(false);
  const [dragOverId,     setDragOverId]     = useState<string | null>(null);
  const [deleteTarget,   setDeleteTarget]   = useState<DriveAsset | null>(null);
  const [deleteError,    setDeleteError]    = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/projects/${projectId}/assets`);
      const data = await res.json() as {
        assets?: DriveAsset[];
        error?: string;
        assetsFolderDriveId?: string;
        assetLinkGroupId?: string;
        sharedFolderName?: string;
        linkedProjects?: { projectId: string; name: string }[];
      };
      if (data.error) throw new Error(data.error);
      setItems(data.assets ?? []);
      setAssetsFolderDriveId(data.assetsFolderDriveId ?? null);
      setLinkGroup(data.assetLinkGroupId
        ? { groupId: data.assetLinkGroupId, sharedFolderName: data.sharedFolderName, linkedProjects: data.linkedProjects ?? [] }
        : null,
      );
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

  // Escape to deselect
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
        setLastSelectedId(null);
        setShowMoveModal(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Lock polling — every 3 s; reloads assets when lock clears
  useEffect(() => {
    let wasLocked = false;
    const poll = async () => {
      try {
        const res  = await fetch(`/api/projects/${projectId}/asset-lock`);
        const data = await res.json() as { locked: boolean; reason?: string; jobId?: string; jobFailed?: boolean };
        setLock(data);
        if (wasLocked && !data.locked) void load();
        wasLocked = data.locked;
      } catch { /* silent */ }
    };
    void poll();
    const id = setInterval(() => void poll(), 3000);
    return () => clearInterval(id);
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

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(asset: DriveAsset) {
    setDeleteError(null);
    const res = await fetch(`/api/projects/${projectId}/assets/${asset.entityId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      // Leave the modal open with an inline error so the user can retry.
      setDeleteError(data.error ?? 'Delete failed');
      return;
    }
    // Drop the asset (and, for a folder, its whole subtree) from the local view —
    // mirrors the index purge the server just did, at any nesting depth.
    setItems((prev) => {
      const removeFileIds = new Set<string>([asset.driveFileId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const i of prev) {
          if (i.isFolder && i.parentDriveId && removeFileIds.has(i.parentDriveId) && !removeFileIds.has(i.driveFileId)) {
            removeFileIds.add(i.driveFileId);
            grew = true;
          }
        }
      }
      return prev.filter((i) =>
        i.entityId !== asset.entityId &&
        !(i.parentDriveId && removeFileIds.has(i.parentDriveId)),
      );
    });
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(asset.entityId); return next; });
    setDeleteTarget(null);
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

  // Batch-download the current selection as a single .zip (folders recursed,
  // structure preserved). A lone selected file downloads directly instead.
  async function handleDownloadZip() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const soleFile = ids.length === 1 ? items.find((i) => i.entityId === ids[0] && !i.isFolder) : null;
    if (soleFile) { handleDownload(soleFile); return; }

    setZipping(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/download-zip`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entityIds: ids, zipName: `${projectName || 'assets'} assets` }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? 'Failed to build zip');
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${projectName || 'assets'} assets.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setZipping(false);
    }
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

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    setUploadProgress({ sent: 0, total: files.reduce((s, f) => s + f.size, 0) });
    try {
      const body = new FormData();
      for (const f of files) body.append('file', f);
      const data = await new Promise<{ ok?: boolean; error?: string; errors?: { name: string; error: string }[] }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `/api/projects/${projectId}/assets/upload`);
          xhr.responseType = 'json';
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) setUploadProgress({ sent: e.loaded, total: e.total });
          };
          xhr.onload = () => {
            const body = xhr.response ?? {};
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new Error((body as { error?: string }).error ?? `Upload failed (${xhr.status})`));
          };
          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.send(body);
        },
      );
      if (data.errors && data.errors.length > 0) {
        setUploadError(`${data.errors.length} file(s) failed to upload`);
      }
      await load();
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    void uploadFiles(files);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files.length > 0) {
      void uploadFiles(Array.from(e.dataTransfer.files));
    }
  }

  // ── New Folder ──────────────────────────────────────────────────────────────

  function openNewFolder() {
    setNewFolderName('');
    setNewFolderMode(true);
    setTimeout(() => newFolderRef.current?.focus(), 0);
  }

  async function commitNewFolder() {
    const name = newFolderName.trim();
    if (!name) { setNewFolderMode(false); return; }
    setCreatingFolder(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/assets/folder`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create folder');
      setNewFolderMode(false);
      await load();
    } catch (err) {
      setUploadError((err as Error).message);
      setNewFolderMode(false);
    } finally {
      setCreatingFolder(false);
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────────

  function handleRowClick(
    node: TreeNode,
    e: React.MouseEvent,
    primaryAction?: () => void,
  ) {
    if (e.shiftKey) {
      e.preventDefault();
      if (lastSelectedId) {
        const ids = visibleNodes.map((n) => n.entityId);
        const a   = ids.indexOf(lastSelectedId);
        const b   = ids.indexOf(node.entityId);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelectedIds((prev) => new Set([...prev, ...ids.slice(lo, hi + 1)]));
          setLastSelectedId(node.entityId);
          return;
        }
      }
      setSelectedIds(new Set([node.entityId]));
      setLastSelectedId(node.entityId);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(node.entityId)) next.delete(node.entityId);
        else next.add(node.entityId);
        return next;
      });
      setLastSelectedId(node.entityId);
      return;
    }
    setSelectedIds(new Set([node.entityId]));
    setLastSelectedId(node.entityId);
    primaryAction?.();
  }

  // ── Move ─────────────────────────────────────────────────────────────────────

  async function executeMoveIds(entityIds: string[], targetDriveId: string) {
    setMoving(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/assets/move`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entityIds, targetDriveId }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Move failed');
      setSelectedIds(new Set());
      setLastSelectedId(null);
      await load();
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setMoving(false);
    }
  }

  function handleMoveTo(targetDriveId: string) {
    setShowMoveModal(false);
    void executeMoveIds(Array.from(selectedIds), targetDriveId);
  }

  // ── Drag-and-drop within list ─────────────────────────────────────────────────

  const DND_TYPE = 'application/x-lpos-asset-ids';

  function onRowDragStart(node: TreeNode, e: React.DragEvent) {
    const ids = selectedIds.has(node.entityId) ? Array.from(selectedIds) : [node.entityId];
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    if (!selectedIds.has(node.entityId)) {
      setSelectedIds(new Set([node.entityId]));
      setLastSelectedId(node.entityId);
    }
  }

  function onFolderDragOver(node: TreeNode, e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(node.driveFileId);
  }

  function onFolderDrop(node: TreeNode, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);
    const raw = e.dataTransfer.getData(DND_TYPE);
    if (!raw) return;
    const ids = JSON.parse(raw) as string[];
    if (ids.includes(node.entityId)) return; // can't drop into itself
    void executeMoveIds(ids, node.driveFileId);
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

  if (lock?.locked) {
    const failed = lock.jobFailed;
    const label = lock.reason === 'unlinking'
      ? 'Setting up a new folder…'
      : failed
        ? 'Merge failed — needs attention'
        : 'Assets are being merged…';
    const sub = lock.reason === 'unlinking'
      ? 'This tab will unlock automatically when the new folder is ready.'
      : failed
        ? 'A merge job encountered an error. An admin can retry or release the lock from the admin panel.'
        : 'This tab will unlock automatically when the merge completes.';
    return (
      <div className="assets-tab">
        <div className={`assets-lock-overlay${failed ? ' assets-lock-overlay--error' : ''}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <p className="assets-lock-label">{label}</p>
          <p className="assets-lock-sub">{sub}</p>
        </div>
      </div>
    );
  }

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
    <div
      className="assets-tab"
      onClick={(e) => { if (e.target === e.currentTarget) { setSelectedIds(new Set()); setLastSelectedId(null); } }}
    >
      {/* Shared-group banner */}
      {linkGroup && (
        <div className="assets-group-banner">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <span className="assets-group-banner-text">
            Shared with{' '}
            {linkGroup.linkedProjects.length === 0
              ? 'no other projects'
              : linkGroup.linkedProjects.map((p, i) => (
                  <span key={p.projectId}>
                    {i > 0 && ', '}
                    <strong>{p.name}</strong>
                  </span>
                ))
            }
            {linkGroup.sharedFolderName && (
              <span className="assets-group-banner-folder"> · {linkGroup.sharedFolderName}</span>
            )}
          </span>
          <button
            type="button"
            className="assets-group-manage-btn"
            onClick={() => setShowManageModal(true)}
          >
            Manage
          </button>
        </div>
      )}

      {/* Upload drop zone */}
      <div
        className={`proj-upload-zone${isDraggingOver ? ' proj-upload-zone--active' : ''}${uploading ? ' proj-upload-zone--busy' : ''}`}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setIsDraggingOver(true); }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        aria-label="Upload files — click or drag files here"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
      >
        {uploading ? (
          <>
            <span className="proj-upload-zone-label proj-upload-zone-label--drop">
              {uploadProgress && uploadProgress.sent >= uploadProgress.total
                ? 'Processing…'
                : `Uploading… ${uploadProgress ? Math.floor((uploadProgress.sent / Math.max(uploadProgress.total, 1)) * 100) : 0}%`}
            </span>
            <div className="proj-upload-bar-wrap" aria-hidden="true">
              <div
                className="proj-upload-bar-fill"
                style={{ width: `${uploadProgress ? (uploadProgress.sent / Math.max(uploadProgress.total, 1)) * 100 : 0}%` }}
              />
            </div>
          </>
        ) : isDraggingOver ? (
          <span className="proj-upload-zone-label proj-upload-zone-label--drop">Drop to upload</span>
        ) : (
          <>
            <svg className="proj-upload-zone-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span className="proj-upload-zone-label">
              Drag files here or <span className="proj-upload-zone-link">click to browse</span>
            </span>
          </>
        )}
      </div>
      <input
        ref={fileInputRef}
        id={uploadInputId}
        type="file"
        multiple
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        onChange={handleUpload}
        tabIndex={-1}
        aria-hidden="true"
      />

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
          onClick={openNewFolder}
          disabled={newFolderMode || creatingFolder}
          title="Create a new folder in Drive"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
          New Folder
        </button>
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

      {uploadError && (
        <p className="assets-upload-error">{uploadError}</p>
      )}

      {/* Empty state */}
      {items.length === 0 && (
        <div className="assets-empty">
          <p>No assets yet.</p>
          <p style={{ fontSize: '0.82rem' }}>
            Drop files into the <strong>Assets</strong> folder for this project in Google Drive.
          </p>
        </div>
      )}

      {/* Selection action bar */}
      {selectedIds.size > 0 && (
        <div className="assets-selection-bar">
          <span className="assets-selection-count">
            {selectedIds.size} selected
          </span>
          <button
            type="button"
            className="assets-selection-btn"
            onClick={() => setShowMoveModal(true)}
            disabled={moving}
          >
            {moving ? 'Moving…' : 'Move to…'}
          </button>
          <button
            type="button"
            className="assets-selection-btn"
            onClick={() => void handleDownloadZip()}
            disabled={zipping}
          >
            {zipping ? 'Zipping…' : `Download${selectedIds.size > 1 ? ' (zip)' : ''}`}
          </button>
          <button
            type="button"
            className="assets-selection-btn assets-selection-btn--ghost"
            onClick={() => { setSelectedIds(new Set()); setLastSelectedId(null); }}
          >
            Deselect all
          </button>
        </div>
      )}

      {/* Inline new-folder input */}
      {newFolderMode && (
        <div className="assets-new-folder-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <input
            ref={newFolderRef}
            className="assets-rename-input"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitNewFolder(); }
              if (e.key === 'Escape') setNewFolderMode(false);
            }}
            onBlur={() => { if (!creatingFolder) setNewFolderMode(false); }}
            disabled={creatingFolder}
          />
          <span className="assets-new-folder-hint">Enter to create · Esc to cancel</span>
        </div>
      )}

      {/* File list */}
      {visibleNodes.length > 0 && (
        <div className="ca-asset-list" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedIds(new Set()); setLastSelectedId(null); } }}>
          {visibleNodes.map((node) => {
            const depth   = getDepth(node);
            const indent  = depth * 20;
            const isOpen  = expanded.has(node.driveFileId);
            const childCount = node.isFolder ? countFiles(node.children) : 0;

            if (node.isFolder) {
              const isSel    = selectedIds.has(node.entityId);
              const isDragTgt = dragOverId === node.driveFileId;
              return (
                <div
                  key={node.entityId}
                  className={`assets-folder-row${isOpen ? ' assets-folder-row--open' : ''}${isSel ? ' assets-row--selected' : ''}${isDragTgt ? ' assets-folder-row--drag-target' : ''}`}
                  style={{ paddingLeft: 14 + indent, position: 'relative' }}
                  draggable
                  onDragStart={(e) => onRowDragStart(node, e)}
                  onDragEnd={() => setDragOverId(null)}
                  onDragOver={(e) => onFolderDragOver(node, e)}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null); }}
                  onDrop={(e) => onFolderDrop(node, e)}
                  onClick={(e) => handleRowClick(node, e, () => toggleFolder(node.driveFileId))}
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
            const isFileSel   = selectedIds.has(node.entityId);

            return (
              <div
                key={node.entityId}
                className={`ca-asset-row${canPreview ? ' ca-asset-row--previewable' : ''}${isFileSel ? ' assets-row--selected' : ''}`}
                style={{ paddingLeft: 14 + indent, position: 'relative' }}
                draggable
                onDragStart={(e) => onRowDragStart(node, e)}
                onDragEnd={() => setDragOverId(null)}
                onClick={(e) => handleRowClick(node, e)}
                onDoubleClick={() => { if (canPreview) setPreviewAsset(node); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') { if (canPreview) setPreviewAsset(node); } }}
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
                  <button
                    type="button"
                    className="ca-asset-btn ca-asset-btn--danger"
                    title={node.isFolder ? 'Delete folder' : 'Delete'}
                    onClick={(e) => { e.stopPropagation(); setDeleteError(null); setDeleteTarget(node); }}
                  >
                    <TrashIcon />
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

      {showManageModal && linkGroup && (
        <LinkGroupManagementModal
          projectId={projectId}
          projectName={projectName}
          sharedFolderName={linkGroup.sharedFolderName}
          linkedProjects={linkGroup.linkedProjects}
          onClose={() => setShowManageModal(false)}
          onUnlinked={() => { setShowManageModal(false); setLinkGroup(null); void load(); }}
        />
      )}

      {/* Move-to modal */}
      {showMoveModal && (
        <div className="assets-move-overlay" onClick={() => setShowMoveModal(false)}>
          <div className="assets-move-modal" onClick={(e) => e.stopPropagation()}>
            <div className="assets-move-header">
              <span>Move {selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''} to…</span>
              <button type="button" className="assets-move-close" onClick={() => setShowMoveModal(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="assets-move-list">
              {assetsFolderDriveId && (
                <button
                  type="button"
                  className="assets-move-item assets-move-item--root"
                  onClick={() => void handleMoveTo(assetsFolderDriveId)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  Assets root
                </button>
              )}
              {items
                .filter((i) => i.isFolder && !selectedIds.has(i.entityId))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((folder) => {
                  const depth  = getDepth(folder);
                  const indent = depth * 14;
                  return (
                    <button
                      key={folder.entityId}
                      type="button"
                      className="assets-move-item"
                      style={{ paddingLeft: 14 + indent }}
                      onClick={() => void handleMoveTo(folder.driveFileId)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      {folder.name}
                    </button>
                  );
                })
              }
              {items.filter((i) => i.isFolder && !selectedIds.has(i.entityId)).length === 0 && !assetsFolderDriveId && (
                <p className="assets-move-empty">No folders available.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={deleteTarget.isFolder ? 'Delete folder?' : 'Delete asset?'}
          body={deleteTarget.isFolder
            ? `"${deleteTarget.name}" and everything inside it will be moved to the Google Drive trash, where it's recoverable for about 30 days.`
            : `"${deleteTarget.name}" will be moved to the Google Drive trash, where it's recoverable for about 30 days.`}
          confirmLabel="Move to Trash"
          danger
          error={deleteError}
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => { setDeleteTarget(null); setDeleteError(null); }}
        />
      )}
    </div>
  );
}
