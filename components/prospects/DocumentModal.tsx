'use client';

import { useState } from 'react';
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

function typeLabel(type: ProspectDocumentType): string {
  return PROSPECT_DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? 'Document';
}

export function DocumentModal({ prospectId, document, presetType, onSaved, onDeleted, onClose }: Props) {
  const isNew = document === null;
  const type  = document?.type ?? presetType ?? 'other';
  const isOther = type === 'other';

  const [url,   setUrl]   = useState(document?.url   ?? '');
  const [title, setTitle] = useState(document?.title ?? '');
  const [saving,   setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const heading = isNew
    ? (isOther ? 'Add document' : `Link ${typeLabel(type).toLowerCase()}`)
    : `Edit ${typeLabel(type).toLowerCase()}`;

  async function handleSave() {
    if (isOther && !title.trim()) { setError('A label is required.'); return; }
    if (!url.trim()) { setError('A document link is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const endpoint = isNew
        ? `/api/prospects/${prospectId}/documents`
        : `/api/prospects/${prospectId}/documents/${document!.documentId}`;
      const method = isNew ? 'POST' : 'PATCH';
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, url: url.trim(), title: title.trim() || null }),
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
            Unlink this {typeLabel(type).toLowerCase()}? The Google Doc itself isn’t affected.
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

          <div className="modal-field">
            <label className="modal-label">Google Doc link <span style={{ color: 'var(--color-error,#e55)' }}>*</span></label>
            <input className="modal-input" type="url" placeholder="https://docs.google.com/document/d/…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus={!isOther} disabled={saving} />
          </div>

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
          <button type="button" className="modal-btn-primary" onClick={handleSave} disabled={saving || !url.trim() || (isOther && !title.trim())}>
            {saving ? 'Saving…' : (isNew ? 'Add' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
