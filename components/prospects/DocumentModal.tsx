'use client';

import { useRef, useState } from 'react';
import type { ProspectDocument, ProspectDocumentType } from '@/lib/models/prospect';
import { PROSPECT_DOCUMENT_TYPES } from '@/lib/models/prospect';

interface Props {
  prospectId:  string;
  document:    ProspectDocument | null; // null = new
  /** Slot the new doc belongs to. Ignored when editing (uses document.type). */
  presetType?: ProspectDocumentType;
  onSaved:     (document: ProspectDocument) => void;
  onDeleted?:  (documentId: string) => void;
  onClose:     () => void;
}

type Mode = 'link' | 'file';

function typeLabel(type: ProspectDocumentType): string {
  return PROSPECT_DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? 'Document';
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DocumentModal({ prospectId, document, presetType, onSaved, onDeleted, onClose }: Props) {
  const isNew = document === null;
  const type  = document?.type ?? presetType ?? 'other';
  const isOther = type === 'other';

  const [mode,  setMode]  = useState<Mode>(document?.fileKey ? 'file' : 'link');
  const [url,   setUrl]   = useState(document?.url   ?? '');
  const [title, setTitle] = useState(document?.title ?? '');
  const [file,  setFile]  = useState<File | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // An existing uploaded file we keep unless the editor picks a new one.
  const hasExistingFile = !!document?.fileKey;
  const existingFileName = document?.fileName ?? null;

  const heading = isNew
    ? (isOther ? 'Add document' : `Link ${typeLabel(type).toLowerCase()}`)
    : `Edit ${typeLabel(type).toLowerCase()}`;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    if (picked && picked.type !== 'application/pdf' && !picked.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are supported.');
      setFile(null);
      return;
    }
    setError(null);
    setFile(picked);
  }

  async function handleSave() {
    if (isOther && !title.trim()) { setError('A label is required.'); return; }

    if (mode === 'link' && !url.trim()) { setError('A document link is required.'); return; }
    if (mode === 'file' && !file && !hasExistingFile) { setError('Choose a PDF to upload.'); return; }

    setSaving(true);
    setError(null);
    try {
      // In file mode with a freshly-picked file, upload it first and reference
      // the returned key. Otherwise (existing file kept, or link mode) skip.
      let filePayload: { key: string; name: string; mime: string; size: number } | undefined;
      if (mode === 'file' && file) {
        const fd = new FormData();
        fd.append('file', file);
        const up = await fetch(`/api/prospects/${prospectId}/documents/upload`, { method: 'POST', body: fd });
        const upData = await up.json() as { key?: string; name?: string; mime?: string; size?: number; error?: string };
        if (!up.ok || !upData.key) throw new Error(upData.error ?? 'Failed to upload file.');
        filePayload = { key: upData.key, name: upData.name!, mime: upData.mime!, size: upData.size! };
      }

      const endpoint = isNew
        ? `/api/prospects/${prospectId}/documents`
        : `/api/prospects/${prospectId}/documents/${document!.documentId}`;
      const method = isNew ? 'POST' : 'PATCH';

      const payload: Record<string, unknown> = { type, title: title.trim() || null };
      if (mode === 'file') {
        if (filePayload) payload.file = filePayload; // replace/attach; else keep existing on edit
      } else {
        payload.url = url.trim();
      }

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { document?: ProspectDocument; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save document.');
      onSaved(data.document!);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!document) return;
    setDeleting(true);
    try {
      await fetch(`/api/prospects/${prospectId}/documents/${document.documentId}`, { method: 'DELETE' });
      onDeleted?.(document.documentId);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (confirmDelete) {
    return (
      <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
        <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2 className="modal-title">Remove document?</h2>
          </div>
          <p className="modal-body-text">
            {document?.fileKey
              ? `Remove this ${typeLabel(type).toLowerCase()}? The uploaded PDF will be deleted.`
              : `Unlink this ${typeLabel(type).toLowerCase()}? The Google Doc itself isn’t affected.`}
          </p>
          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </button>
            <button type="button" className="modal-btn-danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '6px 8px', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--surface-2,#2a2a2a)' : 'none',
    color: active ? 'var(--text-strong)' : 'var(--muted)',
    border: '1px solid var(--line)', borderRadius: 5,
  });

  const saveDisabled = saving
    || (isOther && !title.trim())
    || (mode === 'link' && !url.trim())
    || (mode === 'file' && !file && !hasExistingFile);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ justifyContent: 'space-between' }}>
          <h2 className="modal-title">{heading}</h2>
          {!isNew && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error,#e55)', fontSize: '0.8rem', padding: '0 4px' }}
            >
              Remove
            </button>
          )}
        </div>

        <div style={{ padding: '0 1.5rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {isOther && (
            <div className="modal-field">
              <label className="modal-label">Label <span style={{ color: 'var(--color-error,#e55)' }}>*</span></label>
              <input className="modal-input" type="text" placeholder="Statement of work" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus disabled={saving} />
            </div>
          )}

          {/* Source toggle: Google Doc link vs uploaded PDF. */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={tabBtn(mode === 'link')} onClick={() => { setMode('link'); setError(null); }} disabled={saving}>
              Google Doc link
            </button>
            <button type="button" style={tabBtn(mode === 'file')} onClick={() => { setMode('file'); setError(null); }} disabled={saving}>
              Upload PDF
            </button>
          </div>

          {mode === 'link' ? (
            <div className="modal-field">
              <label className="modal-label">Google Doc link <span style={{ color: 'var(--color-error,#e55)' }}>*</span></label>
              <input className="modal-input" type="url" placeholder="https://docs.google.com/document/d/…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus={!isOther} disabled={saving} />
            </div>
          ) : (
            <div className="modal-field">
              <label className="modal-label">PDF file <span style={{ color: 'var(--color-error,#e55)' }}>*</span></label>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={onPickFile}
                disabled={saving}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 11px',
                  border: '1px dashed var(--line)', borderRadius: 6, background: 'none', cursor: 'pointer',
                  color: 'var(--text-strong)', fontSize: '0.82rem', textAlign: 'left',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--muted)' }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file
                    ? `${file.name} · ${formatSize(file.size)}`
                    : hasExistingFile
                      ? `Replace ${existingFileName ?? 'current PDF'}`
                      : 'Choose a PDF…'}
                </span>
              </button>
              {hasExistingFile && !file && (
                <p className="modal-label-optional" style={{ margin: '4px 0 0' }}>Keeping the current file unless you pick a new one.</p>
              )}
            </div>
          )}

          {!isOther && (
            <div className="modal-field">
              <label className="modal-label">Caption <span className="modal-label-optional">optional</span></label>
              <input className="modal-input" type="text" placeholder="e.g. Proposal v2" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
            </div>
          )}

          {error && <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="modal-btn-primary" onClick={handleSave} disabled={saveDisabled}>
            {saving ? 'Saving…' : (isNew ? 'Add' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
