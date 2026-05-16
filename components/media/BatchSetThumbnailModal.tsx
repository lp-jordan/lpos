'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface Props {
  projectId: string;
  assetIds: string[];
  onClose: () => void;
  onDone: (result: { updated: number; failed: { assetId: string; reason: string }[] }) => void;
}

type Phase = 'idle' | 'uploading' | 'applying' | 'done' | 'error';

const ACCEPT = 'image/jpeg,image/png';
const MAX_BYTES = 8 * 1024 * 1024;

export function BatchSetThumbnailModal({ projectId, assetIds, onClose, onDone }: Readonly<Props>) {
  const [phase, setPhase]       = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError]       = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const isBusy = phase === 'uploading' || phase === 'applying';

  useEffect(() => {
    if (!isBusy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isBusy]);

  useEffect(() => () => { xhrRef.current?.abort(); }, []);

  const submitFile = useCallback((file: File) => {
    setError(null);

    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('Only JPG or PNG images are supported.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Image is too large (max ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`);
      return;
    }

    setFileName(file.name);
    setProgress(0);
    setPhase('uploading');

    const form = new FormData();
    form.append('image', file);
    form.append('assetIds', JSON.stringify(assetIds));

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('POST', `/api/projects/${projectId}/media/batch-poster`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setProgress(Math.round((e.loaded / e.total) * 95));
      }
    };
    xhr.upload.onloadend = () => {
      setPhase('applying');
      setProgress(96);
    };

    xhr.onerror = () => {
      setPhase('error');
      setError('Network error — could not reach LPOS server.');
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as {
            updated: number;
            failed:  { assetId: string; reason: string }[];
          };
          setProgress(100);
          setPhase('done');
          onDone({ updated: data.updated, failed: data.failed });
        } catch {
          setPhase('error');
          setError('Server returned a malformed response.');
        }
      } else {
        setPhase('error');
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string };
          setError(data.error ?? `Upload failed (HTTP ${xhr.status}).`);
        } catch {
          setError(`Upload failed (HTTP ${xhr.status}).`);
        }
      }
    };

    xhr.send(form);
  }, [projectId, assetIds, onDone]);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (isBusy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) submitFile(file);
  }

  function tryClose() {
    if (isBusy) {
      const ok = window.confirm('An upload is in progress. Leave anyway? Your custom thumbnail will not be applied.');
      if (!ok) return;
      xhrRef.current?.abort();
    }
    onClose();
  }

  let phaseLabel = '';
  if (phase === 'uploading') phaseLabel = `Uploading… ${progress}%`;
  else if (phase === 'applying') phaseLabel = `Applying to ${assetIds.length} asset${assetIds.length === 1 ? '' : 's'}…`;
  else if (phase === 'done') phaseLabel = 'Done.';

  return (
    <>
      <div className="sardius-modal-backdrop" onClick={tryClose} aria-hidden="true" />
      <div className="sardius-modal" role="dialog" aria-label="Set Thumbnail" aria-modal="true">
        <div className="sardius-modal-header">
          <span className="sardius-modal-title">
            Set Thumbnail
            <span className="sardius-modal-count"> — {assetIds.length} asset{assetIds.length === 1 ? '' : 's'}</span>
          </span>
          <button
            type="button"
            className="mad-close-btn"
            onClick={tryClose}
            aria-label="Close"
            style={{ marginLeft: 'auto' }}
          >
            ×
          </button>
        </div>

        <div className="sardius-modal-body">
          <div className="sardius-section">
            {phase === 'idle' || phase === 'error' ? (
              <>
                <div
                  className={`proj-upload-zone${isDragOver ? ' proj-upload-zone--active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                >
                  {isDragOver ? (
                    <span className="proj-upload-zone-label proj-upload-zone-label--drop">Drop to upload</span>
                  ) : (
                    <>
                      <svg className="proj-upload-zone-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span className="proj-upload-zone-label">
                        Drag JPG or PNG here or <span className="proj-upload-zone-link">click to browse</span>
                      </span>
                    </>
                  )}
                </div>
                <span className="proj-upload-zone-hint">
                  Applied as poster on every selected asset · Max 8 MB
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT}
                  style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) submitFile(f);
                    e.target.value = '';
                  }}
                  tabIndex={-1}
                  aria-hidden="true"
                />
                {error && <p className="mad-error" style={{ marginTop: 4 }}>{error}</p>}
              </>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span className="proj-upload-zone-label">
                    {fileName ? `${fileName}` : 'Uploading…'}
                  </span>
                  <div className="tt-progress">
                    <div className="tt-progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <span className="proj-upload-zone-hint">{phaseLabel}</span>
                </div>
                {phase === 'done' && (
                  <p className="proj-upload-zone-hint" style={{ marginTop: 6 }}>
                    Thumbnail applied. Re-copy any embed URLs that were already pasted elsewhere.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <div className="sardius-modal-footer">
          <button
            type="button"
            className="mad-action-btn"
            onClick={tryClose}
            disabled={false}
          >
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </>
  );
}
