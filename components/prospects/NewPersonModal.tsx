'use client';

import { useRef, useState } from 'react';
import type { Prospect } from '@/lib/models/prospect';
import { ACCOUNT_MODELS, PERSON_SOURCES } from '@/lib/models/prospect';
import type { UserSummary } from '@/lib/models/user';

interface Props {
  currentUserId: string;
  accessUsers:   UserSummary[];
  onCreated:     (person: Prospect) => void;
  onClose:       () => void;
}

export function NewPersonModal({ currentUserId, accessUsers, onCreated, onClose }: Props) {
  const companyRef = useRef<HTMLInputElement>(null);
  const [company,      setCompany]      = useState('');
  const [website,      setWebsite]      = useState('');
  const [industry,     setIndustry]     = useState('');
  const [source,       setSource]       = useState('');
  const [accountModel, setAccountModel] = useState('');
  const [assignedTo,   setAssignedTo]   = useState<string[]>([currentUserId]);
  const [openingNote,  setOpeningNote]  = useState('');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  function toggleUser(userId: string) {
    setAssignedTo((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) { setError('Company name is required.'); companyRef.current?.focus(); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/prospects', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company:      company.trim(),
          website:      website.trim() || null,
          industry:     industry.trim() || null,
          source:       source || null,
          accountModel: accountModel || null,
          assignedTo,
          openingNote:  openingNote.trim() || null,
        }),
      });
      const data = await res.json() as { prospect?: Prospect; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create.');
      onCreated(data.prospect!);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">New Prospect</h2>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0 1.5rem 1rem' }}>

            {/* Company name */}
            <div className="modal-field">
              <label className="modal-label">Company Name <span style={{ color: 'var(--color-error,#e55)' }}>*</span></label>
              <input
                ref={companyRef}
                className="modal-input"
                type="text"
                placeholder="Acme Corp"
                value={company}
                onChange={(e) => { setCompany(e.target.value); setError(null); }}
                autoFocus
                disabled={saving}
              />
            </div>

            {/* Website + Industry */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="modal-field">
                <label className="modal-label">Website <span className="modal-label-optional">optional</span></label>
                <input className="modal-input" type="text" placeholder="acme.io" value={website} onChange={(e) => setWebsite(e.target.value)} disabled={saving} />
              </div>
              <div className="modal-field">
                <label className="modal-label">Industry <span className="modal-label-optional">optional</span></label>
                <input className="modal-input" type="text" placeholder="Manufacturing" value={industry} onChange={(e) => setIndustry(e.target.value)} disabled={saving} />
              </div>
            </div>

            {/* Source + Account Model */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="modal-field">
                <label className="modal-label">Source <span className="modal-label-optional">optional</span></label>
                <select className="modal-input modal-select" value={source} onChange={(e) => setSource(e.target.value)} disabled={saving}>
                  <option value="">—</option>
                  {PERSON_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div className="modal-field">
                <label className="modal-label">Account Model <span className="modal-label-optional">optional</span></label>
                <select className="modal-input modal-select" value={accountModel} onChange={(e) => setAccountModel(e.target.value)} disabled={saving}>
                  <option value="">—</option>
                  {ACCOUNT_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </div>

            {/* Assign users */}
            <div className="modal-field">
              <label className="modal-label">Assign users</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {accessUsers.filter((u) => !u.isGuest).map((u) => {
                  const sel = assignedTo.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => toggleUser(u.id)}
                      disabled={saving}
                      style={{
                        padding: '0.3rem 0.65rem', borderRadius: '999px',
                        border:  `1px solid ${sel ? 'var(--accent)' : 'var(--color-border,#444)'}`,
                        background: sel ? 'var(--accent-soft)' : 'transparent',
                        color:      sel ? 'var(--accent-strong)' : 'var(--muted)',
                        fontSize: '0.8rem', cursor: 'pointer', transition: 'all 120ms ease',
                      }}
                    >
                      {u.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Opening note */}
            <div className="modal-field">
              <label className="modal-label">Opening note <span className="modal-label-optional">optional</span></label>
              <textarea
                className="modal-input modal-textarea"
                rows={3}
                placeholder="First contact via LinkedIn…"
                value={openingNote}
                onChange={(e) => setOpeningNote(e.target.value)}
                disabled={saving}
                style={{ resize: 'vertical' }}
              />
            </div>

            {error && <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
          </div>

          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={saving || !company.trim()}>
              {saving ? 'Creating…' : 'Create Prospect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
