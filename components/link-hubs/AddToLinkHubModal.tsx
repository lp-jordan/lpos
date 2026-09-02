'use client';
import { useEffect, useState } from 'react';
import type { HubSummary, OwnerType } from './types';

interface Props {
  assets: Array<{ assetId: string; name: string }>;
  projectId: string;
  onClose: () => void;
  onAdded: (added: number, hubName: string) => void;
}

export function AddToLinkHubModal({ assets, projectId, onClose, onAdded }: Props) {
  const [hubs, setHubs] = useState<HubSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [hubId, setHubId] = useState('');
  const [newName, setNewName] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [newType, setNewType] = useState<OwnerType>('client');
  const [newEmail, setNewEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/link-hubs');
        const data = (await res.json()) as { hubs?: HubSummary[] };
        if (cancelled) return;
        const list = data.hubs ?? [];
        setHubs(list);
        if (list.length) {
          setHubId(list[0].id);
          setMode('existing');
        } else {
          setMode('new');
        }
      } catch {
        if (!cancelled) setError('Could not load hubs.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    setSaving(true);
    setError('');
    try {
      let targetId = hubId;
      let targetName = hubs.find((h) => h.id === hubId)?.name ?? '';

      if (mode === 'new') {
        if (!newName.trim()) {
          setError('Hub name is required.');
          setSaving(false);
          return;
        }
        const res = await fetch('/api/link-hubs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newName.trim(),
            owner_label: (newOwner || newName).trim(),
            owner_type: newType,
            firstEmail: newEmail.trim() || undefined,
          }),
        });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Failed to create hub');
        const created = (await res.json()) as { hub: { id: string; name: string } };
        targetId = created.hub.id;
        targetName = created.hub.name;
      }

      const res = await fetch(`/api/link-hubs/${targetId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: assets.map((a) => ({ asset_id: a.assetId, project_id: projectId, client_title: a.name })),
        }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Failed to add');
      const data = (await res.json()) as { added: number };
      onAdded(data.added, targetName);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  const n = assets.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            Add {n} video{n === 1 ? '' : 's'} to a Link Hub
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading ? (
          <p className="modal-body-text">Loading…</p>
        ) : (
          <div className="modal-form">
            {hubs.length > 0 && (
              <div className="modal-mode-toggle">
                <button type="button" className={`modal-mode-btn${mode === 'existing' ? ' active' : ''}`} onClick={() => setMode('existing')}>
                  Existing hub
                </button>
                <button type="button" className={`modal-mode-btn${mode === 'new' ? ' active' : ''}`} onClick={() => setMode('new')}>
                  New hub
                </button>
              </div>
            )}

            {mode === 'existing' ? (
              <div className="modal-field">
                <label className="modal-label">Choose a hub</label>
                <select className="modal-input" value={hubId} onChange={(e) => setHubId(e.target.value)}>
                  {hubs.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} — {h.owner_label} ({h.video_count})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <>
                <div className="modal-field">
                  <label className="modal-label">Hub name</label>
                  <input className="modal-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Steve — Highlights" autoFocus />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="modal-field">
                    <label className="modal-label">Owner label</label>
                    <input className="modal-input" value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="(defaults to name)" />
                  </div>
                  <div className="modal-field">
                    <label className="modal-label">Owner type</label>
                    <select className="modal-input" value={newType} onChange={(e) => setNewType(e.target.value as OwnerType)}>
                      <option value="client">Client</option>
                      <option value="person">Person</option>
                      <option value="leaderpass">LeaderPass</option>
                    </select>
                  </div>
                </div>
                <div className="modal-field">
                  <label className="modal-label">First login email</label>
                  <input className="modal-input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="orlando@company.com" />
                </div>
              </>
            )}

            {error && <p className="modal-error">{error}</p>}

            <div className="modal-actions">
              <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="modal-btn-primary" onClick={submit} disabled={saving || (mode === 'existing' && !hubId)}>
                {saving ? 'Adding…' : `Add ${n} video${n === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
