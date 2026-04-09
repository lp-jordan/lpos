'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ScriptAsset } from '@/lib/models/script-asset';
import { ScriptEditorPanel } from '@/components/projects/ScriptEditorPanel';
import { useContextMenu } from '@/contexts/ContextMenuContext';

interface Props {
  projectId: string;
  readOnly?: boolean;
}

export function ScriptsTab({ projectId, readOnly = false }: Readonly<Props>) {
  const [scripts,        setScripts]        = useState<ScriptAsset[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [search,         setSearch]         = useState('');
  const [statusFilter,   setStatusFilter]   = useState<'all' | 'uploaded' | 'processing' | 'ready'>('all');
  const [syncing,        setSyncing]        = useState(false);
  const [uploading,      setUploading]      = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadCurrent,  setUploadCurrent]  = useState(0);
  const [uploadTotal,    setUploadTotal]    = useState(0);
  const [uploadError,    setUploadError]    = useState<string | null>(null);
  const [editingScript,  setEditingScript]  = useState<ScriptAsset | null>(null);
  const [isDragOver,     setIsDragOver]     = useState(false);

  // ── Multi-select ──────────────────────────────────────────────────────────
  const [selectedIds,    setSelectedIds]    = useState<Set<string>>(new Set());
  const lastSelectedIdx  = useRef<number>(-1);
  const fileListRef      = useRef<HTMLDivElement>(null);

  const { openMenu } = useContextMenu();

  // Deselect when clicking anywhere outside the script list
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (fileListRef.current && !fileListRef.current.contains(e.target as Node)) {
        setSelectedIds(new Set());
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/scripts`);
      if (!res.ok) return;
      const data = await res.json() as { scripts: ScriptAsset[] };
      setScripts(data.scripts);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchScripts(); }, [fetchScripts]);

  // Poll while any script is still processing
  useEffect(() => {
    const processing = scripts.some((s) => s.status === 'processing');
    if (!processing) return;
    const id = setInterval(() => { void fetchScripts(); }, 2000);
    return () => clearInterval(id);
  }, [scripts, fetchScripts]);

  const filtered = scripts.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    return true;
  });

  // ── Row click — select only; double-click opens editor ───────────────────

  function handleRowClick(script: ScriptAsset, idx: number, e: React.MouseEvent) {
    // Ignore clicks on the delete button inside the row
    if ((e.target as HTMLElement).closest('.proj-file-action--danger')) return;

    if (e.ctrlKey || e.metaKey) {
      // Toggle individual selection without opening editor
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(script.scriptId)) { next.delete(script.scriptId); }
        else { next.add(script.scriptId); }
        return next;
      });
      lastSelectedIdx.current = idx;
      return;
    }

    if (e.shiftKey && lastSelectedIdx.current !== -1) {
      // Range select
      const from = Math.min(lastSelectedIdx.current, idx);
      const to   = Math.max(lastSelectedIdx.current, idx);
      setSelectedIds(new Set(filtered.slice(from, to + 1).map((s) => s.scriptId)));
      return;
    }

    // Plain click — select only, do not open editor
    setSelectedIds(new Set([script.scriptId]));
    lastSelectedIdx.current = idx;
  }

  function handleRowDoubleClick(script: ScriptAsset) {
    setEditingScript(script);
  }

  // ── Right-click context menu ──────────────────────────────────────────────

  function handleRowContextMenu(script: ScriptAsset, idx: number, e: React.MouseEvent) {
    e.preventDefault();

    // If right-clicking an item outside the current selection, select it
    if (!selectedIds.has(script.scriptId)) {
      setSelectedIds(new Set([script.scriptId]));
      lastSelectedIdx.current = idx;
    }

    const isMulti = selectedIds.has(script.scriptId) && selectedIds.size > 1;
    const count   = isMulti ? selectedIds.size : 1;

    openMenu(e.clientX, e.clientY, [
      ...(!isMulti ? [{
        type: 'item' as const,
        label: 'Open',
        icon: <OpenIcon />,
        onClick: () => setEditingScript(script),
      }] : []),
      ...(!isMulti ? [{ type: 'separator' as const }] : []),
      ...(!readOnly ? [{
        type: 'item' as const,
        label: count > 1 ? `Delete ${count} scripts` : 'Delete',
        icon: <TrashIcon />,
        danger: true,
        onClick: () => {
          if (isMulti) {
            void handleDeleteSelected();
          } else {
            void handleDelete(script);
          }
        },
      }] : []),
    ]);
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  const ACCEPTED_EXTS = ['.docx', '.pdf', '.txt', '.doc'];
  const fileInputRef = useRef<HTMLInputElement>(null);

  function filterAccepted(files: FileList | File[]): File[] {
    return Array.from(files).filter((f) =>
      ACCEPTED_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
  }

  function uploadFile(file: File): Promise<boolean> {
    return new Promise((resolve) => {
      const formData = new FormData();
      formData.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status === 201) { resolve(true); return; }
        try {
          const d = JSON.parse(xhr.responseText) as { error?: string };
          setUploadError(d.error ?? `Upload failed for "${file.name}"`);
        } catch { setUploadError(`Upload failed for "${file.name}"`); }
        resolve(false);
      };
      xhr.onerror = () => { setUploadError(`Network error uploading "${file.name}"`); resolve(false); };
      xhr.open('POST', `/api/projects/${projectId}/scripts`);
      xhr.send(formData);
    });
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    setUploadTotal(files.length);
    for (let i = 0; i < files.length; i++) {
      setUploadCurrent(i + 1);
      setUploadProgress(0);
      await uploadFile(files[i]);
    }
    setUploading(false);
    setUploadProgress(0);
    setUploadCurrent(0);
    setUploadTotal(0);
    void fetchScripts();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = filterAccepted(e.target.files ?? new FileList());
    if (files.length > 0) void uploadFiles(files);
    e.target.value = '';
  }

  // ── Drag & drop ───────────────────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragOver(true); }
  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const files = filterAccepted(e.dataTransfer.files);
    if (files.length > 0) void uploadFiles(files);
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  async function handleSync() {
    setSyncing(true);
    try { await new Promise((r) => setTimeout(r, 1200)); }
    finally { setSyncing(false); }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete(script: ScriptAsset) {
    if (!confirm(`Delete "${script.name}"?`)) return;
    await fetch(
      `/api/projects/${projectId}/scripts/${script.scriptId}?deleteFile=true`,
      { method: 'DELETE' },
    );
    if (editingScript?.scriptId === script.scriptId) setEditingScript(null);
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(script.scriptId); return n; });
    void fetchScripts();
  }

  async function handleDeleteSelected() {
    const ids = [...selectedIds];
    if (!confirm(`Delete ${ids.length} scripts?`)) return;
    await Promise.all(ids.map((id) =>
      fetch(`/api/projects/${projectId}/scripts/${id}?deleteFile=true`, { method: 'DELETE' }),
    ));
    if (editingScript && ids.includes(editingScript.scriptId)) setEditingScript(null);
    setSelectedIds(new Set());
    void fetchScripts();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <p className="m-empty">Loading…</p>;

  const uploadLabel = uploadTotal > 1
    ? `Uploading ${uploadCurrent} of ${uploadTotal} — ${uploadProgress}%`
    : `Uploading — ${uploadProgress}%`;

  return (
    <>
      <div className="proj-tab-content page-stack">

        {/* Drop zone */}
        <div
          className={`proj-upload-zone${isDragOver ? ' proj-upload-zone--active' : ''}${uploading ? ' proj-upload-zone--busy' : ''}`}
          onClick={() => !uploading && fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          aria-label="Upload scripts — click or drag files here"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
        >
          {uploading ? (
            <>
              <div className="proj-upload-bar-wrap">
                <div className="proj-upload-bar-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <span className="proj-upload-zone-label">{uploadLabel}</span>
            </>
          ) : isDragOver ? (
            <span className="proj-upload-zone-label proj-upload-zone-label--drop">Drop to upload</span>
          ) : (
            <>
              <UploadIcon />
              <span className="proj-upload-zone-label">
                Drag files here or <span className="proj-upload-zone-link">click to browse</span>
              </span>
              <span className="proj-upload-zone-hint">.docx · .pdf · .txt</span>
            </>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,.pdf,.txt,.doc"
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

        {/* Toolbar — only when scripts exist */}
        {scripts.length > 0 && (
          <div className="proj-scripts-toolbar">
            <input
              className="proj-search"
              type="text"
              placeholder="Search scripts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="proj-filter-pills">
              {(['all', 'uploaded', 'processing', 'ready'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`proj-filter-pill${statusFilter === s ? ' active' : ''}`}
                  onClick={() => setStatusFilter(s)}
                >
                  {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`proj-sync-btn${syncing ? ' proj-sync-btn--spinning' : ''}`}
              onClick={handleSync}
              disabled={syncing}
              title="Sync with LeaderPrompt"
              aria-label="Sync with LeaderPrompt"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
          </div>
        )}

        {/* Script list */}
        {filtered.length > 0 && (
          <div className="proj-file-list" ref={fileListRef}>
            {filtered.map((s, idx) => (
              <ScriptRow
                key={s.scriptId}
                script={s}
                isEditing={editingScript?.scriptId === s.scriptId}
                isSelected={selectedIds.has(s.scriptId)}
                readOnly={readOnly}
                onClick={(e) => handleRowClick(s, idx, e)}
                onDoubleClick={() => handleRowDoubleClick(s)}
                onContextMenu={(e) => handleRowContextMenu(s, idx, e)}
                onDelete={() => handleDelete(s)}
              />
            ))}
          </div>
        )}

        {filtered.length === 0 && scripts.length > 0 && (
          <p className="m-empty">No scripts match your search.</p>
        )}
      </div>

      <ScriptEditorPanel
        projectId={projectId}
        script={editingScript}
        onClose={() => setEditingScript(null)}
        onSaved={() => { void fetchScripts(); }}
      />
    </>
  );
}

// ── ScriptRow ─────────────────────────────────────────────────────────────────

function ScriptRow({
  script,
  isEditing,
  isSelected,
  readOnly,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDelete,
}: {
  script: ScriptAsset;
  isEditing: boolean;
  isSelected: boolean;
  readOnly?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDelete: () => void;
}) {
  const ext = script.originalFilename.split('.').pop()?.toUpperCase() ?? '';

  return (
    <div
      className={[
        'proj-file-row proj-file-row--script proj-file-row--clickable',
        isEditing  ? 'proj-file-row--active'   : '',
        isSelected ? 'proj-file-row--selected' : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onDoubleClick(); }
        if (e.key === ' ')     { e.preventDefault(); onClick(e as unknown as React.MouseEvent); }
      }}
    >
      <ScriptIcon mimeType={script.mimeType} />
      <div className="proj-file-info">
        <span className="proj-file-name">{script.name}</span>
        <span className="proj-file-meta">
          {ext}
          {script.fileSize != null && ` · ${formatBytes(script.fileSize)}`}
        </span>
      </div>
      <span className="proj-file-date">{formatDate(script.uploadedAt)}</span>
      <span className={`proj-file-status proj-file-status--${script.status}`}>
        {script.status === 'processing' ? 'Extracting…' : script.status}
      </span>
      {!readOnly && (
        <div className="proj-file-actions">
          <button
            type="button"
            className="proj-file-action proj-file-action--danger"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete script"
          >
            <TrashIcon small />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function UploadIcon() {
  return (
    <svg className="proj-upload-zone-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

function TrashIcon({ small }: { small?: boolean }) {
  const s = small ? 13 : 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
    </svg>
  );
}

function ScriptIcon({ mimeType }: { mimeType: string }) {
  const isPdf  = mimeType === 'application/pdf';
  const isDocx = mimeType.includes('wordprocessingml');
  if (isPdf) return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="12" y2="11"/>
    </svg>
  );
  if (isDocx) return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
    </svg>
  );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
