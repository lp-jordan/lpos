'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PhotoAsset } from '@/lib/models/photo-asset';
import { useContextMenu } from '@/contexts/ContextMenuContext';

interface Props {
  projectId: string;
  projectName: string;
}

type SortKey = 'uploadedAt' | 'captureDate' | 'name' | 'size';
type SortDir = 'asc' | 'desc';
type EditedFilter = 'all' | 'edited' | 'not-edited';
type ViewMode = 'list' | 'grid';

const PHOTO_INPUT_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/tiff,.dng,.arw';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name',         label: 'Name' },
  { value: 'uploadedAt',   label: 'Uploaded' },
  { value: 'captureDate',  label: 'Captured' },
  { value: 'size',         label: 'Size' },
];

const EDITED_OPTIONS: { value: EditedFilter; label: string }[] = [
  { value: 'all',        label: 'All' },
  { value: 'edited',     label: 'Edited' },
  { value: 'not-edited', label: 'Unedited' },
];

const IconUpload = () => (
  <svg className="proj-upload-zone-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return '—'; }
}

interface UploadResponse {
  uploads?: PhotoAsset[];
  error?: string;
}

function uploadWithProgress(
  url: string,
  form: FormData,
  onProgress: (sent: number, total: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as UploadResponse;
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    xhr.send(form);
  });
}

function sortPhotos(photos: PhotoAsset[], key: SortKey, dir: SortDir): PhotoAsset[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...photos].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'uploadedAt':
        cmp = a.uploadedAt.localeCompare(b.uploadedAt);
        break;
      case 'captureDate': {
        const av = a.captureDate ?? '';
        const bv = b.captureDate ?? '';
        cmp = av.localeCompare(bv);
        break;
      }
      case 'name':
        cmp = a.originalFilename.localeCompare(b.originalFilename, undefined, { sensitivity: 'base' });
        break;
      case 'size':
        cmp = a.fileSize - b.fileSize;
        break;
    }
    return cmp * sign;
  });
}

export function PhotosTab({ projectId, projectName }: Readonly<Props>) {
  const { openMenu, closeMenu } = useContextMenu();
  const [photos, setPhotos] = useState<PhotoAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadFeedback, setUploadFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('uploadedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [editedFilter, setEditedFilter] = useState<EditedFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/photos`);
      if (!res.ok) throw new Error(`Failed to load photos (${res.status})`);
      const data = await res.json() as { photos: PhotoAsset[] };
      setPhotos(data.photos);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Click-away deselect
  useEffect(() => {
    function handleClickAway(e: MouseEvent) {
      if (selectedIds.size === 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!contentRef.current?.contains(target)) {
        setSelectedIds(new Set());
        setLastSelectedId(null);
      }
    }
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [selectedIds.size]);

  const displayed = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = photos.filter((p) => {
      if (editedFilter === 'edited' && !p.edited) return false;
      if (editedFilter === 'not-edited' && p.edited) return false;
      if (term && !p.originalFilename.toLowerCase().includes(term)) return false;
      return true;
    });
    return sortPhotos(filtered, sortKey, sortDir);
  }, [photos, search, sortKey, sortDir, editedFilter]);

  const allDisplayedSelected = displayed.length > 0 && displayed.every((p) => selectedIds.has(p.photoId));

  function toggleSelectAll() {
    if (allDisplayedSelected) {
      setSelectedIds(new Set());
      setLastSelectedId(null);
    } else {
      setSelectedIds(new Set(displayed.map((p) => p.photoId)));
      setLastSelectedId(displayed.at(-1)?.photoId ?? null);
    }
  }

  function handleRowClick(photoId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (e.shiftKey && lastSelectedId) {
      const idxA = displayed.findIndex((p) => p.photoId === lastSelectedId);
      const idxB = displayed.findIndex((p) => p.photoId === photoId);
      if (idxA >= 0 && idxB >= 0) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        const range = displayed.slice(lo, hi + 1).map((p) => p.photoId);
        setSelectedIds((prev) => new Set([...prev, ...range]));
        setLastSelectedId(photoId);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(photoId)) next.delete(photoId);
        else next.add(photoId);
        return next;
      });
      setLastSelectedId(photoId);
      return;
    }
    setSelectedIds((prev) => {
      if (prev.size === 1 && prev.has(photoId)) return new Set();
      return new Set([photoId]);
    });
    setLastSelectedId(photoId);
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setIsUploading(true);
    setUploadFeedback(null);
    const totalBytes = list.reduce((acc, f) => acc + f.size, 0);
    setUploadProgress({ sent: 0, total: totalBytes });
    try {
      const form = new FormData();
      for (const f of list) form.append('file', f, f.name);
      const data = await uploadWithProgress(
        `/api/projects/${projectId}/photos`,
        form,
        (sent, total) => setUploadProgress({ sent, total }),
      );
      const count = data.uploads?.length ?? 0;
      setUploadFeedback({ message: `Uploaded ${count} ${count === 1 ? 'photo' : 'photos'}.`, isError: false });
      await refresh();
    } catch (err) {
      setUploadFeedback({ message: (err as Error).message, isError: true });
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
  }

  async function setEditedFor(ids: string[], edited: boolean) {
    if (ids.length === 0) return;
    try {
      if (ids.length === 1) {
        await fetch(`/api/projects/${projectId}/photos/${ids[0]}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edited }),
        });
      } else {
        await fetch(`/api/projects/${projectId}/photos/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-edited', photoIds: ids, edited }),
        });
      }
      setPhotos((prev) => prev.map((p) => (ids.includes(p.photoId) ? { ...p, edited } : p)));
    } catch (err) {
      setUploadFeedback({ message: (err as Error).message, isError: true });
    }
  }

  async function deletePhotos(ids: string[]) {
    if (ids.length === 0) return;
    const confirmMsg = ids.length === 1
      ? 'Delete this photo? The file will be removed from disk.'
      : `Delete ${ids.length} photos? The files will be removed from disk.`;
    if (!window.confirm(confirmMsg)) return;
    try {
      if (ids.length === 1) {
        await fetch(`/api/projects/${projectId}/photos/${ids[0]}`, { method: 'DELETE' });
      } else {
        await fetch(`/api/projects/${projectId}/photos/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', photoIds: ids }),
        });
      }
      setPhotos((prev) => prev.filter((p) => !ids.includes(p.photoId)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    } catch (err) {
      setUploadFeedback({ message: (err as Error).message, isError: true });
    }
  }

  function downloadOne(photo: PhotoAsset) {
    window.location.href = `/api/projects/${projectId}/photos/${photo.photoId}/download`;
  }

  async function downloadZip(ids: string[]) {
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/photos/download-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoIds: ids, zipName: `${projectName} photos` }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || `Zip download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${projectName} photos.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setUploadFeedback({ message: (err as Error).message, isError: true });
    }
  }

  function handleContextMenu(photo: PhotoAsset, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const targets = selectedIds.has(photo.photoId) && selectedIds.size > 1
      ? Array.from(selectedIds)
      : [photo.photoId];
    const multi = targets.length > 1;
    openMenu(e.clientX, e.clientY, [
      {
        type: 'item',
        label: multi ? `Download ${targets.length} as zip` : 'Download',
        onClick: () => {
          closeMenu();
          if (multi) void downloadZip(targets);
          else downloadOne(photo);
        },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: multi ? `Mark ${targets.length} as edited` : 'Mark as edited',
        onClick: () => { closeMenu(); void setEditedFor(targets, true); },
      },
      {
        type: 'item',
        label: multi ? `Mark ${targets.length} as not edited` : 'Mark as not edited',
        onClick: () => { closeMenu(); void setEditedFor(targets, false); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: multi ? `Delete ${targets.length} photos` : 'Delete',
        danger: true,
        onClick: () => { closeMenu(); void deletePhotos(targets); },
      },
    ]);
  }

  const selectedArr = Array.from(selectedIds);

  return (
    <div ref={contentRef} className="pho-tab">
      {/* Drop zone */}
      <div
        className={`proj-upload-zone${isDraggingOver ? ' proj-upload-zone--active' : ''}${isUploading ? ' proj-upload-zone--busy' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        aria-label="Upload photos — click or drag files here"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
      >
        {isUploading ? (
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
            <span className="proj-upload-zone-hint">
              {uploadProgress ? `${formatSize(uploadProgress.sent)} / ${formatSize(uploadProgress.total)}` : ''}
            </span>
          </>
        ) : isDraggingOver ? (
          <span className="proj-upload-zone-label proj-upload-zone-label--drop">Drop to upload</span>
        ) : (
          <>
            <IconUpload />
            <span className="proj-upload-zone-label">
              Drag photos here or <span className="proj-upload-zone-link">click to browse</span>
            </span>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={PHOTO_INPUT_ACCEPT}
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
          e.target.value = '';
        }}
        tabIndex={-1}
        aria-hidden="true"
      />

      {uploadFeedback && (
        <p className={`m-upload-feedback${uploadFeedback.isError ? ' m-upload-feedback--error' : ''}`}>
          {uploadFeedback.message}
        </p>
      )}

      {/* Toolbar */}
      <div className="ma-toolbar">
        <div className="ma-select-all-wrap">
          <input
            type="checkbox"
            className="ma-checkbox"
            disabled={displayed.length === 0}
            checked={allDisplayedSelected}
            onChange={toggleSelectAll}
            aria-label="Select all"
            title="Select all"
          />
        </div>
        <input
          className="proj-search"
          type="text"
          placeholder="Search photos…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="ma-sort-controls">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`ma-sort-btn${sortKey === opt.value ? ' ma-sort-btn--active' : ''}`}
              onClick={() => {
                if (sortKey === opt.value) {
                  setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                } else {
                  setSortKey(opt.value);
                  setSortDir(opt.value === 'name' ? 'asc' : 'desc');
                }
              }}
            >
              {opt.label}
              {sortKey === opt.value && (
                <span className="ma-sort-arrow">{sortDir === 'asc' ? '↑' : '↓'}</span>
              )}
            </button>
          ))}
        </div>
        <div className="ma-toolbar-right">
          <div className="ma-sort-controls" role="group" aria-label="Edited filter">
            {EDITED_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`ma-sort-btn${editedFilter === opt.value ? ' ma-sort-btn--active' : ''}`}
                onClick={() => setEditedFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="m-view-toggle">
            <button
              type="button"
              className={`m-view-btn${viewMode === 'list' ? ' active' : ''}`}
              onClick={() => setViewMode('list')}
              aria-label="List view"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            </button>
            <button
              type="button"
              className={`m-view-btn${viewMode === 'grid' ? ' active' : ''}`}
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Count */}
      <div className="pho-count">
        {displayed.length} {displayed.length === 1 ? 'photo' : 'photos'}{search || editedFilter !== 'all' ? ` (of ${photos.length})` : ''}
      </div>

      {/* Selection bar */}
      {selectedIds.size > 0 && (
        <div className="ma-selection-bar-wrap">
          <div className="ma-selection-bar">
            <span>{selectedIds.size} selected</span>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => void setEditedFor(selectedArr, true)}
            >Mark edited</button>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => void setEditedFor(selectedArr, false)}
            >Mark not edited</button>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => {
                if (selectedArr.length === 1) {
                  const p = photos.find((x) => x.photoId === selectedArr[0]);
                  if (p) downloadOne(p);
                } else {
                  void downloadZip(selectedArr);
                }
              }}
            >Download{selectedArr.length > 1 ? ' (zip)' : ''}</button>
            <button
              type="button"
              className="ma-selection-action ma-selection-action--danger"
              onClick={() => void deletePhotos(selectedArr)}
            >Delete</button>
            <button
              type="button"
              className="ma-selection-action"
              onClick={() => { setSelectedIds(new Set()); setLastSelectedId(null); }}
            >Clear</button>
          </div>
        </div>
      )}

      {/* Body */}
      {error && <p className="m-upload-feedback m-upload-feedback--error">{error}</p>}
      {loading && <p className="m-empty">Loading…</p>}
      {!loading && displayed.length === 0 && (
        <p className="m-empty">{photos.length === 0 ? 'No photos yet. Drop files above to upload.' : 'No photos match the current filters.'}</p>
      )}

      {!loading && displayed.length > 0 && viewMode === 'grid' && (
        <div className="pho-grid">
          {displayed.map((photo, idx) => (
            <PhotoCard
              key={photo.photoId}
              photo={photo}
              projectId={projectId}
              selected={selectedIds.has(photo.photoId)}
              onClick={(e) => handleRowClick(photo.photoId, e)}
              onDoubleClick={() => setPreviewIndex(idx)}
              onContextMenu={(e) => handleContextMenu(photo, e)}
            />
          ))}
        </div>
      )}

      {!loading && displayed.length > 0 && viewMode === 'list' && (
        <div className="pho-list">
          {displayed.map((photo, idx) => (
            <PhotoRow
              key={photo.photoId}
              photo={photo}
              projectId={projectId}
              selected={selectedIds.has(photo.photoId)}
              onClick={(e) => handleRowClick(photo.photoId, e)}
              onDoubleClick={() => setPreviewIndex(idx)}
              onContextMenu={(e) => handleContextMenu(photo, e)}
            />
          ))}
        </div>
      )}

      {previewIndex !== null && displayed[previewIndex] && (
        <PhotoPreviewModal
          photo={displayed[previewIndex]}
          projectId={projectId}
          hasPrev={previewIndex > 0}
          hasNext={previewIndex < displayed.length - 1}
          onClose={() => setPreviewIndex(null)}
          onPrev={() => setPreviewIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
          onNext={() => setPreviewIndex((i) => (i !== null && i < displayed.length - 1 ? i + 1 : i))}
        />
      )}
    </div>
  );
}

function PhotoCard({
  photo, projectId, selected, onClick, onDoubleClick, onContextMenu,
}: Readonly<{
  photo: PhotoAsset;
  projectId: string;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}>) {
  return (
    <div
      className={`pho-card${selected ? ' pho-card--selected' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
    >
      <div className="pho-card-thumb">
        <img
          src={`/api/projects/${projectId}/photos/${photo.photoId}/thumbnail`}
          alt={photo.originalFilename}
          loading="lazy"
        />
        {photo.edited && <span className="pho-badge pho-badge--edited">Edited</span>}
      </div>
      <div className="pho-card-body">
        <div className="pho-card-name" title={photo.originalFilename}>{photo.originalFilename}</div>
        <div className="pho-card-meta">
          <span>{formatSize(photo.fileSize)}</span>
          <span>{formatDate(photo.captureDate ?? photo.uploadedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function PhotoRow({
  photo, projectId, selected, onClick, onDoubleClick, onContextMenu,
}: Readonly<{
  photo: PhotoAsset;
  projectId: string;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}>) {
  return (
    <div
      className={`ma-row${selected ? ' ma-row--selected' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="ma-row-check">
        <input type="checkbox" checked={selected} onChange={() => { /* click handler manages */ }} onClick={(e) => e.stopPropagation()} />
      </div>
      <div className="ma-row-thumb pho-row-thumb">
        <img
          src={`/api/projects/${projectId}/photos/${photo.photoId}/thumbnail`}
          alt={photo.originalFilename}
          loading="lazy"
        />
      </div>
      <div className="ma-row-main">
        <div className="ma-filename" title={photo.originalFilename}>{photo.originalFilename}</div>
        <div className="ma-description">
          {formatSize(photo.fileSize)} · Captured {formatDate(photo.captureDate)} · Uploaded {formatDate(photo.uploadedAt)}
        </div>
      </div>
      <div className="ma-row-badges">
        {photo.edited && <span className="ma-badge">Edited</span>}
      </div>
    </div>
  );
}

function PhotoPreviewModal({
  photo, projectId, hasPrev, hasNext, onClose, onPrev, onNext,
}: Readonly<{
  photo: PhotoAsset;
  projectId: string;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}>) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      else if (e.key === 'ArrowRight' && hasNext) onNext();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPrev, hasNext, onClose, onPrev, onNext]);

  if (!mounted) return null;

  return createPortal(
    <div className="pho-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Preview: ${photo.originalFilename}`}>
      <button
        type="button"
        className="pho-modal-nav pho-modal-nav--prev"
        onClick={(e) => { e.stopPropagation(); onPrev(); }}
        disabled={!hasPrev}
        aria-label="Previous photo"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <figure className="pho-modal-body" onClick={(e) => e.stopPropagation()}>
        <img
          key={photo.photoId}
          className="pho-modal-image"
          src={`/api/projects/${projectId}/photos/${photo.photoId}/preview`}
          alt={photo.originalFilename}
        />
        <figcaption className="pho-modal-filename">{photo.originalFilename}</figcaption>
      </figure>
      <button
        type="button"
        className="pho-modal-nav pho-modal-nav--next"
        onClick={(e) => { e.stopPropagation(); onNext(); }}
        disabled={!hasNext}
        aria-label="Next photo"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
    </div>,
    document.body,
  );
}
