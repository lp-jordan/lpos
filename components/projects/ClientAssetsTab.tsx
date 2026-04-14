'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

type AssetType = 'pdf' | 'docx' | 'image' | 'video' | 'other';
type FilterType = 'all' | AssetType;
type Destination = 'assets' | 'scripts';

interface IngestFile {
  file_name:    string;
  file_size:    number;
  mime_type:    string;
  file_key:     string;
  created_at:   string;
  processed:    boolean;
  promoted_to:  string | null;
  promoted_at:  string | null;
}

interface IngestData {
  token:     string | null;
  clientUrl: string | null;
  files:     IngestFile[];
}

interface FileWithType extends IngestFile {
  assetType: AssetType;
}

// ── Type resolution ───────────────────────────────────────────────────────────

function mimeToType(mime: string, fileName: string): AssetType {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('wordprocessingml') || mime.includes('msword') || mime.includes('opendocument.text')) return 'docx';
  if (mime.startsWith('text/') || mime === 'application/x-fountain' || mime === 'application/x-fdx') return 'docx';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['docx','doc','odt','rtf','txt','md','fountain','fdx'].includes(ext)) return 'docx';
  if (['png','jpg','jpeg','gif','webp','bmp','heic','svg'].includes(ext)) return 'image';
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return 'video';
  return 'other';
}

const isPreviewable = (f: FileWithType): boolean =>
  f.assetType === 'image' || f.assetType === 'pdf' || f.assetType === 'docx' || f.assetType === 'video';

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICONS: Record<AssetType, { color: string; label: string; svg: React.ReactNode }> = {
  pdf: {
    color: '#e8706a',
    label: 'PDF',
    svg: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h4"/>
      </svg>
    ),
  },
  docx: {
    color: '#5b9cf6',
    label: 'DOC',
    svg: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h6"/>
      </svg>
    ),
  },
  image: {
    color: '#7ec87e',
    label: 'IMG',
    svg: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    ),
  },
  video: {
    color: '#a78bfa',
    label: 'VID',
    svg: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2"/>
      </svg>
    ),
  },
  other: {
    color: '#94a3b8',
    label: 'FILE',
    svg: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
        <polyline points="13 2 13 9 20 9"/>
      </svg>
    ),
  },
};

// ── Preview panel ─────────────────────────────────────────────────────────────

function PreviewPanel({
  file,
  projectId,
  onClose,
}: {
  file: FileWithType | null;
  projectId: string;
  onClose: () => void;
}) {
  const isOpen = file !== null;
  const downloadHref = file
    ? `/api/ingest/${projectId}/download?key=${encodeURIComponent(file.file_key)}`
    : '#';
  const meta = file ? ICONS[file.assetType] : null;

  return (
    <>
      <div
        className={`m-detail-overlay${isOpen ? ' m-detail-overlay--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`asset-preview-panel${isOpen ? ' asset-preview-panel--open' : ''}`}
        aria-label="File preview"
      >
        {file && meta && (
          <div className="asset-preview-inner">
            <div className="asset-preview-header">
              <div className="asset-preview-header-info">
                <span className="asset-preview-ext" style={{ color: meta.color }}>{meta.label}</span>
                <span className="asset-preview-filename" title={file.file_name}>{file.file_name}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                <a href={downloadHref} className="ca-icon-btn" title="Download" download>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </a>
                <button type="button" className="m-detail-close" onClick={onClose} aria-label="Close preview">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>

            <div className="asset-preview-body">
              {file.assetType === 'video' ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={downloadHref}
                  controls
                  className="asset-preview-video"
                />
              ) : file.assetType === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={downloadHref}
                  alt={file.file_name}
                  className="asset-preview-img"
                />
              ) : (
                <iframe
                  src={downloadHref}
                  className="asset-preview-pdf-frame"
                  title={file.file_name}
                />
              )}
            </div>

            <div className="asset-preview-footer">
              <span className="asset-preview-meta-item">{formatSize(file.file_size)}</span>
              <span className="asset-preview-meta-item">{formatDate(file.created_at)}</span>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId:   string;
  projectName: string;
  clientName:  string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ClientAssetsTab({ projectId, projectName: _projectName, clientName }: Props) {
  const [data,        setData]        = useState<IngestData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [creating,    setCreating]    = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [filter,      setFilter]      = useState<FilterType>('all');
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [destination,  setDestination]  = useState<Destination>('assets');
  const [promoting,       setPromoting]       = useState(false);
  const [promoteError,    setPromoteError]    = useState<string | null>(null);
  const [preview,         setPreview]         = useState<FileWithType | null>(null);
  const [promotedOpen,    setPromotedOpen]    = useState(false);
  const pollRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSelectedIdx = useRef<number>(-1);
  const fileListRef     = useRef<HTMLDivElement>(null);

  // ── Data loading ───────────────────────────────────────────────────────────

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/ingest/${projectId}`);
      if (res.ok) setData(await res.json());
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    // Poll every 20 s so newly uploaded files appear without a manual refresh
    pollRef.current = setInterval(() => void load(true), 20_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  // Deselect when clicking outside the file list
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (fileListRef.current && !fileListRef.current.contains(e.target as Node)) {
        setSelected(new Set());
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await fetch(`/api/ingest/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientName }),
      });
      if (res.ok) await load();
    } finally {
      setCreating(false);
    }
  }

  function handleCopy() {
    if (!data?.clientUrl) return;
    void navigator.clipboard.writeText(data.clientUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleRowClick(file: FileWithType, idx: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(file.file_key)) next.delete(file.file_key);
        else next.add(file.file_key);
        return next;
      });
      lastSelectedIdx.current = idx;
      return;
    }

    if (e.shiftKey && lastSelectedIdx.current !== -1) {
      const from = Math.min(lastSelectedIdx.current, idx);
      const to   = Math.max(lastSelectedIdx.current, idx);
      setSelected(new Set(filteredPending.slice(from, to + 1).map((f) => f.file_key)));
      return;
    }

    setSelected(new Set([file.file_key]));
    lastSelectedIdx.current = idx;
  }

  function handleRowDoubleClick(file: FileWithType) {
    if (isPreviewable(file)) setPreview(preview?.file_key === file.file_key ? null : file);
  }

  async function handlePromote() {
    if (selected.size === 0 || promoting) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const pendingByKey = new Map(
        (data?.files ?? []).filter((f) => !f.processed).map((f) => [f.file_key, f])
      );
      let filesToPromote = [...selected]
        .map((key) => pendingByKey.get(key))
        .filter((f): f is IngestFile => !!f);

      // Scripts only accepts text documents — filter out everything else
      if (destination === 'scripts') {
        filesToPromote = filesToPromote.filter((f) => {
          const t = mimeToType(f.mime_type ?? '', f.file_name);
          return t === 'pdf' || t === 'docx';
        });
      }

      if (!filesToPromote.length) return;

      const res = await fetch(`/api/ingest/${projectId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: filesToPromote.map((f) => ({
            fileKey:  f.file_key,
            filename: f.file_name,
            mimeType: f.mime_type ?? 'application/octet-stream',
            fileSize: Number(f.file_size ?? 0),
          })),
          destination,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setPromoteError(body.error ?? `Server error ${res.status}`);
        return;
      }

      setSelected(new Set());
      // Reload after a short delay so the pipeline tracker has time to start
      setTimeout(() => void load(true), 1500);
    } catch (err) {
      setPromoteError((err as Error).message ?? 'Promotion failed');
    } finally {
      setPromoting(false);
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const allFiles = (data?.files ?? []).map((f) => ({
    ...f,
    assetType: mimeToType(f.mime_type ?? '', f.file_name),
  })) as FileWithType[];

  const pending   = allFiles.filter((f) => !f.processed);
  const processed = allFiles.filter((f) => f.processed);

  const filteredPending = filter === 'all'
    ? pending
    : pending.filter((f) => f.assetType === filter);

  const availableTypes = [...new Set(pending.map((f) => f.assetType))];

  const docCount   = pending.filter((f) => f.assetType === 'pdf' || f.assetType === 'docx').length;
  const imageCount = pending.filter((f) => f.assetType === 'image').length;
  const videoCount = pending.filter((f) => f.assetType === 'video').length;

  // Whether any selected file is a text document (eligible for Scripts)
  const selectedHasDoc = allFiles.some((f) =>
    selected.has(f.file_key) && (f.assetType === 'pdf' || f.assetType === 'docx')
  );

  // ── No token state ─────────────────────────────────────────────────────────

  if (!loading && data?.token == null) {
    return (
      <div className="ca-tab proj-tab-content page-stack">
        <div className="ca-no-link">
          <div className="ca-no-link-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
          </div>
          <p className="ca-no-link-title">No upload link yet</p>
          <p className="ca-no-link-sub">Generate a unique link for {clientName} to upload files directly to this project.</p>
          <button type="button" className="btn" onClick={handleCreate} disabled={creating}>
            {creating ? 'Generating…' : 'Generate upload link'}
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="ca-tab proj-tab-content page-stack ca-loading">Loading…</div>;
  }

  // ── Main layout (split when preview is open) ───────────────────────────────

  return (
    <div className="ca-tab proj-tab-content page-stack">

      <div className="ca-main" ref={fileListRef}>

        {/* ── Portal URL bar ── */}
        <div className="ca-url-bar">
          <div className="ca-url-bar-left">
            <div className="ca-url-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
            </div>
            <div className="ca-url-info">
              <span className="ca-url-label">Client Upload Portal</span>
              <span className="ca-url-value">{data?.clientUrl}</span>
            </div>
          </div>
          <div className="ca-url-actions">
            <button type="button" className="ca-url-copy" onClick={handleCopy} title="Copy link">
              {copied
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              }
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <a href={data?.clientUrl ?? '#'} target="_blank" rel="noopener noreferrer" className="ca-url-share">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>

        {/* ── Stats row ── */}
        <div className="ca-stats">
          <div className="ca-stat">
            <span className="ca-stat-num">{pending.length}</span>
            <span className="ca-stat-label">Pending</span>
          </div>
          <div className="ca-stat-divider" />
          <div className="ca-stat">
            <span className="ca-stat-num">{docCount}</span>
            <span className="ca-stat-label">Documents</span>
          </div>
          <div className="ca-stat-divider" />
          <div className="ca-stat">
            <span className="ca-stat-num">{imageCount}</span>
            <span className="ca-stat-label">Images</span>
          </div>
          <div className="ca-stat-divider" />
          <div className="ca-stat">
            <span className="ca-stat-num">{videoCount}</span>
            <span className="ca-stat-label">Videos</span>
          </div>
          {processed.length > 0 && (
            <>
              <div className="ca-stat-divider" />
              <div className="ca-stat">
                <span className="ca-stat-num">{processed.length}</span>
                <span className="ca-stat-label">Promoted</span>
              </div>
            </>
          )}
        </div>

        {/* ── Filter pills ── */}
        {pending.length > 0 && (
          <div className="ca-filters">
            <button
              type="button"
              className={`ca-filter-pill${filter === 'all' ? ' ca-filter-pill--active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All ({pending.length})
            </button>
            {availableTypes.map((t) => (
              <button
                key={t}
                type="button"
                className={`ca-filter-pill${filter === t ? ' ca-filter-pill--active' : ''}`}
                onClick={() => setFilter(t as FilterType)}
              >
                {ICONS[t].label}
              </button>
            ))}
          </div>
        )}

        {/* ── Batch action bar ── */}
        {selected.size > 0 && (
          <div className="ca-batch-bar">
            <span className="ca-batch-count">{selected.size} selected</span>
            <div className="ca-batch-actions">
              {promoteError && (
                <span className="ca-batch-error" title={promoteError}>
                  {promoteError}
                </span>
              )}
              <label className="ca-batch-dest-label">
                To
                <select
                  className="ca-batch-dest"
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value as Destination);
                    setPromoteError(null);
                  }}
                >
                  <option value="assets">Assets</option>
                  <option value="scripts" disabled={!selectedHasDoc}>
                    Scripts{!selectedHasDoc ? ' (docs only)' : ''}
                  </option>
                </select>
              </label>
              <button
                type="button"
                className="btn btn--sm ca-promote-btn"
                onClick={handlePromote}
                disabled={promoting}
              >
                {promoting ? 'Promoting…' : 'Promote'}
              </button>
              <button
                type="button"
                className="ca-icon-btn"
                onClick={() => { setSelected(new Set()); setPromoteError(null); }}
                title="Clear selection"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* ── Pending file list ── */}
        {filteredPending.length > 0 ? (
          <div className="ca-asset-list">
            {filteredPending.map((file, idx) => {
              const meta         = ICONS[file.assetType];
              const isSelected   = selected.has(file.file_key);
              const isPreviewed  = preview?.file_key === file.file_key;
              const canPreview   = isPreviewable(file);
              const downloadHref = `/api/ingest/${projectId}/download?key=${encodeURIComponent(file.file_key)}`;

              return (
                <div
                  key={file.file_key}
                  className={`ca-asset-row ca-asset-row--clickable${isSelected ? ' ca-asset-row--selected' : ''}${isPreviewed ? ' ca-asset-row--previewed' : ''}`}
                  onClick={(e) => handleRowClick(file, idx, e)}
                  onDoubleClick={() => handleRowDoubleClick(file)}
                  role="row"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canPreview) handleRowDoubleClick(file);
                    if (e.key === ' ') { e.preventDefault(); handleRowClick(file, idx, e as unknown as React.MouseEvent); }
                  }}
                >
                  <div className="ca-asset-icon" style={{ color: meta.color }}>
                    {meta.svg}
                  </div>

                  <div className="ca-asset-info">
                    <span className="ca-asset-name">{file.file_name}</span>
                    <span className="ca-asset-meta">
                      <span
                        className="ca-asset-badge"
                        style={{ color: meta.color, borderColor: `${meta.color}44`, background: `${meta.color}12` }}
                      >
                        {meta.label}
                      </span>
                      <span>{formatSize(file.file_size)}</span>
                      <span>·</span>
                      <span>{formatDate(file.created_at)}</span>
                      {canPreview && <span className="ca-asset-preview-hint">double-click to preview</span>}
                    </span>
                  </div>

                  <div className="ca-asset-actions">
                    <a
                      href={downloadHref}
                      className="ca-asset-btn"
                      title="Download"
                      download
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        ) : filter !== 'all' ? (
          <div className="ca-upload-prompt">
            <p className="ca-upload-prompt-sub">No {filter} files in the queue.</p>
          </div>
        ) : null}

        {/* ── Processed section ── */}
        {processed.length > 0 && (
          <div className="ca-processed-section">
            <button
              type="button"
              className="ca-processed-heading ca-processed-toggle"
              onClick={() => setPromotedOpen((o) => !o)}
            >
              Promoted ({processed.length})
            </button>
            {promotedOpen && <div className="ca-asset-list ca-asset-list--processed">
              {processed.map((file) => {
                const meta = ICONS[file.assetType];
                return (
                  <div key={file.file_key} className="ca-asset-row ca-asset-row--processed">
                    <div className="ca-asset-icon" style={{ color: meta.color }}>
                      {meta.svg}
                    </div>
                    <div className="ca-asset-info">
                      <span className="ca-asset-name">{file.file_name}</span>
                      <span className="ca-asset-meta">
                        <span
                          className="ca-asset-badge"
                          style={{ color: meta.color, borderColor: `${meta.color}44`, background: `${meta.color}12` }}
                        >
                          {meta.label}
                        </span>
                        <span>{formatSize(file.file_size)}</span>
                        <span>·</span>
                        <span className="ca-processed-dest">
                          → {file.promoted_to ?? 'assets'}
                        </span>
                        {file.promoted_at && (
                          <>
                            <span>·</span>
                            <span>{formatDate(file.promoted_at)}</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="ca-asset-actions">
                      <span className="ca-processed-badge">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Done
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>}
          </div>
        )}

      </div>{/* end .ca-main */}

      <PreviewPanel
        file={preview}
        projectId={projectId}
        onClose={() => setPreview(null)}
      />

    </div>
  );
}
