'use client';

import { useState } from 'react';
import type { ProspectDocument, ProspectDocumentType } from '@/lib/models/prospect';
import { FIXED_DOCUMENT_TYPES, PROSPECT_DOCUMENT_TYPES } from '@/lib/models/prospect';
import { parseGoogleDoc } from '@/lib/utils/google-doc';
import { DocumentModal } from './DocumentModal';

// Accent + label colours per slot. Fill drives the top bar; label is a darker
// stop from the same family so it reads on the light cover surface.
const TYPE_FILL: Record<ProspectDocumentType, string> = {
  proposal:  '#378ADD',
  contract:  '#1D9E75',
  blueprint: '#BA7517',
  other:     '#888780',
};
const TYPE_LABEL_COLOR: Record<ProspectDocumentType, string> = {
  proposal:  '#185FA5',
  contract:  '#0F6E56',
  blueprint: '#854F0B',
  other:     '#5F5E5A',
};

function slotLabel(type: ProspectDocumentType): string {
  return PROSPECT_DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? 'Document';
}

// ── One cover ──────────────────────────────────────────────────────────────

function DocumentCover({ prospectId, doc, onEdit }: { prospectId: string; doc: ProspectDocument; onEdit: () => void }) {
  const [thumbOk, setThumbOk] = useState(false);
  const [copied,  setCopied]  = useState(false);
  const [hovered, setHovered] = useState(false);

  const fill  = TYPE_FILL[doc.type];
  const label = TYPE_LABEL_COLOR[doc.type];
  // For `other` docs the caption/label lives in `title`; for fixed slots the
  // badge is the slot name and `title` is the optional caption underneath.
  const badge   = doc.type === 'other' ? (doc.title || 'Document') : slotLabel(doc.type);
  const caption = doc.type === 'other' ? '' : (doc.title || '');
  const info    = parseGoogleDoc(doc.url);

  const isFile = !!doc.fileKey;

  async function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    // Uploaded files store a root-relative serve URL; copy an absolute link.
    const link = doc.url.startsWith('/') ? `${window.location.origin}${doc.url}` : doc.url;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — no-op */ }
  }

  const actionBtn: React.CSSProperties = {
    background: 'rgba(255,255,255,0.14)', border: 'none', cursor: 'pointer', color: '#fff',
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 7px',
    borderRadius: 4, fontSize: '0.62rem', fontWeight: 600, lineHeight: 1,
    width: '82%', maxWidth: 110, textDecoration: 'none', boxSizing: 'border-box',
    whiteSpace: 'nowrap', overflow: 'hidden',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div
        className="doc-cover"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: 'relative', aspectRatio: '3 / 4', borderRadius: 6,
          border: '1px solid var(--line)', background: 'var(--surface-1)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}
      >
        {/* accent bar */}
        <div style={{ height: 4, background: fill, flexShrink: 0 }} />

        {/* uploaded-file marker — distinguishes a PDF from a linked Google Doc */}
        {isFile && (
          <span style={{
            position: 'absolute', top: 8, right: 6, zIndex: 1,
            background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '0.5rem', fontWeight: 700,
            letterSpacing: '0.05em', padding: '1px 4px', borderRadius: 3,
          }}>
            PDF
          </span>
        )}

        {/* generated placeholder body */}
        <div style={{ flex: 1, padding: 8, display: 'flex', flexDirection: 'column', minHeight: 0, filter: hovered ? 'blur(1.5px)' : 'none', transition: 'filter 140ms ease' }}>
          <span style={{ fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: label, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {badge}
          </span>
          <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ height: 3, width: '85%', background: 'var(--line)', borderRadius: 1 }} />
            <span style={{ height: 3, width: '65%', background: 'var(--line)', borderRadius: 1 }} />
            <span style={{ height: 3, width: '75%', background: 'var(--line)', borderRadius: 1 }} />
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" style={{ marginTop: 'auto' }} aria-hidden="true">
            <path d="M8 3 L4 10 L12 10 Z" /><path d="M12 3 H20 L16 10 H8 Z" opacity="0.5" />
          </svg>
        </div>

        {/* real Drive thumbnail, if the file resolves through the service account */}
        {doc.fileId && (
          <img
            src={`/api/prospects/${prospectId}/documents/${doc.documentId}/thumbnail`}
            alt=""
            onLoad={() => setThumbOk(true)}
            onError={() => setThumbOk(false)}
            style={{
              position: 'absolute', top: 4, left: 0, right: 0, bottom: 0,
              width: '100%', height: 'calc(100% - 4px)', objectFit: 'cover',
              objectPosition: 'top', opacity: thumbOk ? 1 : 0,
              filter: hovered ? 'blur(1.5px)' : 'none',
              transition: 'opacity 160ms ease, filter 140ms ease',
            }}
          />
        )}

        {/* hover actions — opacity + pointer-events driven by state so an
            invisible overlay never intercepts clicks (inline opacity would
            beat a CSS :hover rule, so we don't use one). */}
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
          opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none',
          transition: 'opacity 140ms ease',
        }}>
          <a href={doc.url} target="_blank" rel="noopener noreferrer" title="Open" style={actionBtn} onClick={(e) => e.stopPropagation()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open
          </a>
          <button type="button" title={copied ? 'Copied' : 'Copy link'} style={actionBtn} onClick={copyLink}>
            {copied
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
              : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {info?.exportPdfUrl && (
            <a href={info.exportPdfUrl} target="_blank" rel="noopener noreferrer" title="Export PDF" style={actionBtn} onClick={(e) => e.stopPropagation()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              PDF
            </a>
          )}
          <button type="button" title="Edit" style={actionBtn} onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
            Edit
          </button>
        </div>
      </div>

      <span style={{ fontSize: '0.68rem', color: caption ? 'var(--text-strong)' : 'var(--muted)', textAlign: 'center', lineHeight: 1.3, fontWeight: caption ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {caption || (doc.type === 'other' ? '' : slotLabel(doc.type))}
      </span>
    </div>
  );
}

// ── Empty fixed slot ─────────────────────────────────────────────────────────

function EmptySlot({ type, onClick }: { type: ProspectDocumentType; onClick: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          aspectRatio: '3 / 4', borderRadius: 6, border: '1px dashed var(--color-border,#444)',
          background: 'none', cursor: 'pointer', color: 'var(--muted)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 6,
          transition: 'border-color 120ms ease, color 120ms ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent-strong)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border,#444)'; e.currentTarget.style.color = 'var(--muted)'; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span style={{ fontSize: '0.6rem', textAlign: 'center', lineHeight: 1.2 }}>{slotLabel(type)}</span>
      </button>
      <span style={{ fontSize: '0.68rem', color: 'var(--muted)', textAlign: 'center' }}>Not linked</span>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function DocumentsPanel({ personId, documents, onChange }: { personId: string; documents: ProspectDocument[]; onChange: (d: ProspectDocument[]) => void }) {
  // modal: { doc } edits an existing; { type } adds new to a slot; null = closed.
  const [modal, setModal] = useState<{ doc: ProspectDocument | null; type: ProspectDocumentType } | null>(null);

  function handleSaved(document: ProspectDocument) {
    const exists = documents.find((d) => d.documentId === document.documentId);
    onChange(exists ? documents.map((d) => d.documentId === document.documentId ? document : d) : [...documents, document]);
    setModal(null);
  }

  function handleDeleted(documentId: string) {
    onChange(documents.filter((d) => d.documentId !== documentId));
    setModal(null);
  }

  const extras = documents.filter((d) => d.type === 'other');

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p className="eyebrow" style={{ margin: 0 }}>Documents</p>
        <button type="button" onClick={() => setModal({ doc: null, type: 'other' })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-strong)', fontSize: '0.8rem', padding: 0 }}>
          + Add
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 12 }}>
        {FIXED_DOCUMENT_TYPES.map((type) => {
          const doc = documents.find((d) => d.type === type);
          return doc
            ? <DocumentCover key={type} prospectId={personId} doc={doc} onEdit={() => setModal({ doc, type })} />
            : <EmptySlot key={type} type={type} onClick={() => setModal({ doc: null, type })} />;
        })}
        {extras.map((doc) => (
          <DocumentCover key={doc.documentId} prospectId={personId} doc={doc} onEdit={() => setModal({ doc, type: 'other' })} />
        ))}
      </div>

      {modal && (
        <DocumentModal
          prospectId={personId}
          document={modal.doc}
          presetType={modal.type}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
