'use client';

import { useState } from 'react';
import type { ProspectContact } from '@/lib/models/prospect';

interface Props {
  prospectId: string;
  contact:    ProspectContact | null; // null = new contact
  onSaved:    (contact: ProspectContact) => void;
  onDeleted?: (contactId: string) => void;
  onClose:    () => void;
  readOnly?:  boolean;
}

export function ContactModal({ prospectId, contact, onSaved, onDeleted, onClose, readOnly }: Props) {
  const isNew = contact === null;

  const [name,     setName]     = useState(contact?.name     ?? '');
  const [role,     setRole]     = useState(contact?.role     ?? '');
  const [email,    setEmail]    = useState(contact?.email    ?? '');
  const [phone,    setPhone]    = useState(contact?.phone    ?? '');
  const [linkedin, setLinkedin] = useState(contact?.linkedin ?? '');
  const [editing,  setEditing]  = useState(isNew);
  const [saving,   setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const url    = isNew
        ? `/api/prospects/${prospectId}/contacts`
        : `/api/prospects/${prospectId}/contacts/${contact!.contactId}`;
      const method = isNew ? 'POST' : 'PATCH';
      const res    = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:     name.trim(),
          role:     role.trim()     || null,
          email:    email.trim()    || null,
          phone:    phone.trim()    || null,
          linkedin: linkedin.trim() || null,
        }),
      });
      const data = await res.json() as { contact?: ProspectContact; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save contact.');
      onSaved(data.contact!);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!contact) return;
    setDeleting(true);
    try {
      await fetch(`/api/prospects/${prospectId}/contacts/${contact.contactId}`, { method: 'DELETE' });
      onDeleted?.(contact.contactId);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    padding:      '0.4rem 0.65rem',
    borderRadius: '6px',
    border:       '1px solid var(--color-border,#444)',
    background:   'var(--color-input-bg,#1a1a1a)',
    color:        'inherit',
    fontSize:     '0.875rem',
    width:        '100%',
    boxSizing:    'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize:    '0.72rem',
    fontWeight:  700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color:       'var(--muted-soft)',
    marginBottom: 4,
    display:     'block',
  };

  const valueStyle: React.CSSProperties = {
    fontSize:  '0.9rem',
    color:     'var(--text)',
    wordBreak: 'break-all',
  };

  const mutedStyle: React.CSSProperties = {
    fontSize: '0.85rem',
    color:    'var(--muted)',
    fontStyle: 'italic',
  };

  if (confirmDelete) {
    return (
      <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
        <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2 className="modal-title">Remove contact?</h2>
          </div>
          <p className="modal-body-text">
            Remove <strong>{contact?.name}</strong> from this prospect? This cannot be undone.
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
          <h2 className="modal-title">{isNew ? 'Add Contact' : (editing ? 'Edit Contact' : contact!.name)}</h2>
          {!isNew && !editing && !readOnly && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setEditing(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-strong)', fontSize: '0.8rem', padding: '0 4px' }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error,#e55)', fontSize: '0.8rem', padding: '0 4px' }}
              >
                Remove
              </button>
            </div>
          )}
        </div>

        <div style={{ padding: '0 1.5rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {editing ? (
            <>
              <div className="modal-field">
                <label className="modal-label">Name <span style={{ color: 'var(--color-error,#e55)' }}>*</span></label>
                <input className="modal-input" type="text" placeholder="Jane Smith" value={name} onChange={(e) => setName(e.target.value)} autoFocus disabled={saving} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="modal-field">
                  <label className="modal-label">Role <span className="modal-label-optional">optional</span></label>
                  <input className="modal-input" type="text" placeholder="CEO" value={role} onChange={(e) => setRole(e.target.value)} disabled={saving} />
                </div>
                <div className="modal-field">
                  <label className="modal-label">Email <span className="modal-label-optional">optional</span></label>
                  <input className="modal-input" type="email" placeholder="jane@acme.io" value={email} onChange={(e) => setEmail(e.target.value)} disabled={saving} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="modal-field">
                  <label className="modal-label">Phone <span className="modal-label-optional">optional</span></label>
                  <input className="modal-input" type="text" placeholder="+1 555 000 0000" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={saving} />
                </div>
                <div className="modal-field">
                  <label className="modal-label">LinkedIn <span className="modal-label-optional">optional</span></label>
                  <input className="modal-input" type="text" placeholder="linkedin.com/in/…" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} disabled={saving} />
                </div>
              </div>
              {error && <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
            </>
          ) : (
            /* View mode */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {contact?.role && (
                <div>
                  <span style={labelStyle}>Role</span>
                  <span style={valueStyle}>{contact.role}</span>
                </div>
              )}
              <div>
                <span style={labelStyle}>Email</span>
                {contact?.email
                  ? <a href={`mailto:${contact.email}`} style={{ ...valueStyle, color: 'var(--accent-strong)' }}>{contact.email}</a>
                  : <span style={mutedStyle}>—</span>}
              </div>
              <div>
                <span style={labelStyle}>Phone</span>
                {contact?.phone
                  ? <a href={`tel:${contact.phone}`} style={{ ...valueStyle, color: 'var(--accent-strong)' }}>{contact.phone}</a>
                  : <span style={mutedStyle}>—</span>}
              </div>
              <div>
                <span style={labelStyle}>LinkedIn</span>
                {contact?.linkedin
                  ? <span style={valueStyle}>{contact.linkedin}</span>
                  : <span style={mutedStyle}>—</span>}
              </div>
            </div>
          )}
        </div>

        <div className="modal-actions">
          {editing && !isNew && (
            <button type="button" className="modal-btn-ghost" onClick={() => { setEditing(false); setError(null); }} disabled={saving}>
              Cancel
            </button>
          )}
          {!editing && (
            <button type="button" className="modal-btn-ghost" onClick={onClose}>
              Close
            </button>
          )}
          {editing && (
            <button type="button" className="modal-btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : (isNew ? 'Add Contact' : 'Save')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
