'use client';

import { useState } from 'react';
import type { Project } from '@/lib/models/project';

interface Props {
  onClose: () => void;
  onCreated: (project: Project) => void;
  defaultClientName?: string;
  existingClients?: string[];
}

export function NewProjectModal({ onClose, onCreated, defaultClientName, existingClients = [] }: Readonly<Props>) {
  // If a defaultClientName is pinned, skip the mode toggle entirely.
  // Otherwise default to 'existing' when there are clients, 'new' when there aren't.
  const hasPinnedClient = !!defaultClientName;
  const initialMode = hasPinnedClient || existingClients.length === 0 ? 'new' : 'existing';

  const [mode, setMode] = useState<'existing' | 'new'>(initialMode);
  const [selectedClient, setSelectedClient] = useState(existingClients[0] ?? '');
  const [newClientName, setNewClientName] = useState(defaultClientName ?? '');
  const [projectName, setProjectName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const clientName = hasPinnedClient
    ? defaultClientName
    : mode === 'existing'
      ? selectedClient
      : newClientName;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientName?.trim() || !projectName.trim()) {
      setError('Client name and project name are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName.trim(), clientName: clientName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to create project');
      }
      const data = await res.json() as { project: Project };
      onCreated(data.project);
      onClose();
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
          <h2 className="modal-title">New Project</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Mode toggle — only shown when there are existing clients and no pinned client */}
        {!hasPinnedClient && existingClients.length > 0 && (
          <div className="modal-mode-toggle">
            <button
              type="button"
              className={`modal-mode-btn${mode === 'existing' ? ' active' : ''}`}
              onClick={() => setMode('existing')}
            >
              Existing Client
            </button>
            <button
              type="button"
              className={`modal-mode-btn${mode === 'new' ? ' active' : ''}`}
              onClick={() => setMode('new')}
            >
              New Client
            </button>
          </div>
        )}

        <form className="modal-form" onSubmit={handleSubmit}>
          {/* Client field */}
          <div className="modal-field">
            <label className="modal-label" htmlFor="np-client">Client</label>
            {hasPinnedClient ? (
              <input
                id="np-client"
                className="modal-input"
                type="text"
                value={defaultClientName}
                readOnly
                disabled
              />
            ) : mode === 'existing' ? (
              <select
                id="np-client"
                className="modal-input"
                value={selectedClient}
                onChange={(e) => setSelectedClient(e.target.value)}
                autoFocus
              >
                {existingClients.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            ) : (
              <input
                id="np-client"
                className="modal-input"
                type="text"
                placeholder="Acme Productions"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                autoFocus
                autoComplete="off"
              />
            )}
          </div>

          <div className="modal-field">
            <label className="modal-label" htmlFor="np-name">Project Name</label>
            <input
              id="np-name"
              className="modal-input"
              type="text"
              placeholder="Annual Summit Highlights"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              autoFocus={hasPinnedClient}
              autoComplete="off"
            />
          </div>

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
