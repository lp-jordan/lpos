'use client';

import { useState, useEffect, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PreviewableAsset {
  entityId:  string;
  name:      string;
  mimeType:  string | null;
  fileSize:  number | null;
  modifiedAt: string | null;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'image'; url: string }
  | { status: 'docx';  url: string }
  | { status: 'error'; message: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/bmp', 'image/tiff', 'image/svg+xml', 'image/heic',
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.heic']);
const OFFICE_EXTS = new Set([
  '.doc', '.docx', '.odt', '.rtf',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
]);

const GAPPS_PREVIEWABLE = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function isPreviewable(asset: PreviewableAsset): boolean {
  const mime = asset.mimeType ?? '';
  const ext  = fileExt(asset.name);
  return IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext) || OFFICE_EXTS.has(ext) || GAPPS_PREVIEWABLE.has(mime);
}

function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024)          return `${n} B`;
  if (n < 1024 * 1024)   return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  asset:     PreviewableAsset | null;
  projectId: string;
  onClose:   () => void;
}

export function AssetPreviewPanel({ asset, projectId, onClose }: Readonly<Props>) {
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const objectUrlRef = useRef<string | null>(null);

  // Revoke any blob URL created for a previous asset
  function revokeObjectUrl() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  useEffect(() => {
    revokeObjectUrl();

    if (!asset) { setPreview({ status: 'idle' }); return; }

    const mime = asset.mimeType ?? '';
    const ext  = fileExt(asset.name);
    const isImage     = IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext);
    const isOfficeDoc = OFFICE_EXTS.has(ext) || GAPPS_PREVIEWABLE.has(mime);

    if (isImage) {
      setPreview({
        status: 'image',
        url: `/api/projects/${projectId}/assets/${asset.entityId}/preview`,
      });
      return;
    }

    if (isOfficeDoc) {
      // Fetch the PDF blob so we can show a real loading spinner during conversion
      // (first open: 4–8 s; subsequent opens: instant from server cache).
      setPreview({ status: 'loading' });
      let cancelled = false;

      fetch(`/api/projects/${projectId}/assets/${asset.entityId}/preview`)
        .then((r) => {
          if (!r.ok) return r.json().then((d: { error?: string }) => { throw new Error(d.error ?? 'Conversion failed'); });
          return r.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setPreview({ status: 'docx', url });
        })
        .catch((err: Error) => {
          if (!cancelled) setPreview({ status: 'error', message: err.message });
        });

      return () => { cancelled = true; };
    }

    setPreview({ status: 'idle' });
  }, [asset, projectId]);

  // Clean up blob URL on unmount
  useEffect(() => revokeObjectUrl, []);

  const isOpen = asset !== null;
  const ext    = asset ? fileExt(asset.name).replace('.', '').toUpperCase() : '';

  return (
    <>
      {/* Backdrop */}
      <div
        className={`m-detail-overlay${isOpen ? ' m-detail-overlay--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside
        className={`asset-preview-panel${isOpen ? ' asset-preview-panel--open' : ''}`}
        aria-label="Asset preview"
      >
        {asset && (
          <div className="asset-preview-inner">

            {/* Header */}
            <div className="asset-preview-header">
              <div className="asset-preview-header-info">
                {ext && <span className="asset-preview-ext">{ext}</span>}
                <span className="asset-preview-filename" title={asset.name}>{asset.name}</span>
              </div>
              <button
                type="button"
                className="m-detail-close"
                onClick={onClose}
                aria-label="Close preview"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Preview body */}
            <div className="asset-preview-body">
              {preview.status === 'loading' && (
                <div className="asset-preview-loading">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                    style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  <span>Loading preview…</span>
                </div>
              )}

              {preview.status === 'image' && (
                <div className="asset-preview-image-wrap">
                  <img
                    src={preview.url}
                    alt={asset.name}
                    className="asset-preview-img"
                    onError={() => setPreview({ status: 'error', message: 'Failed to load image' })}
                  />
                </div>
              )}

              {preview.status === 'docx' && (
                <iframe
                  src={preview.url}
                  className="asset-preview-pdf-frame"
                  title={asset.name}
                />
              )}

              {preview.status === 'error' && (
                <div className="asset-preview-error">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{preview.message}</span>
                </div>
              )}
            </div>

            {/* Metadata footer */}
            <div className="asset-preview-footer">
              {asset.fileSize != null && (
                <span className="asset-preview-meta-item">{formatBytes(asset.fileSize)}</span>
              )}
              {asset.modifiedAt && (
                <span className="asset-preview-meta-item">Modified {formatDate(asset.modifiedAt)}</span>
              )}
            </div>

          </div>
        )}
      </aside>
    </>
  );
}
