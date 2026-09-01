'use client';
import { useState } from 'react';
import type { OwnerType } from './types';

interface Props {
  onClose: () => void;
  onCreated: (hubId: string) => void;
}

export function NewHubModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [ownerLabel, setOwnerLabel] = useState('');
  const [ownerType, setOwnerType] = useState<OwnerType>('client');
  const [firstEmail, setFirstEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Hub name is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/link-hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          owner_label: (ownerLabel || name).trim(),
          owner_type: ownerType,
          firstEmail: firstEmail.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to create hub');
      }
      const data = (await res.json()) as { hub: { id: string } };
      onCreated(data.hub.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">New link hub</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form className="modal-form" onSubmit={submit}>
          <div className="modal-field">
            <label className="modal-label">Hub name</label>
            <input className="modal-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Steve — Highlights" autoFocus />
          </div>
          <div className="modal-field">
            <label className="modal-label">Owner label</label>
            <input className="modal-input" value={ownerLabel} onChange={(e) => setOwnerLabel(e.target.value)} placeholder="Steve Molyneux (defaults to hub name)" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="modal-field">
              <label className="modal-label">Owner type</label>
              <select className="modal-input" value={ownerType} onChange={(e) => setOwnerType(e.target.value as OwnerType)}>
                <option value="client">Client</option>
                <option value="person">Person</option>
                <option value="leaderpass">LeaderPass</option>
              </select>
            </div>
            <div className="modal-field">
              <label className="modal-label">First login email</label>
              <input className="modal-input" type="email" value={firstEmail} onChange={(e) => setFirstEmail(e.target.value)} placeholder="orlando@company.com" />
            </div>
          </div>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create hub'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
