'use client';

import { useState } from 'react';

interface LinkedProject {
  projectId: string;
  name:      string;
}

interface Props {
  projectId:        string;
  projectName:      string;
  sharedFolderName?: string;
  linkedProjects:   LinkedProject[];
  onClose:          () => void;
  onUnlinked:       () => void;
}

export function LinkGroupManagementModal({
  projectId, projectName, sharedFolderName, linkedProjects, onClose, onUnlinked,
}: Props) {
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  async function handleUnlink() {
    setUnlinking(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/link-assets/unlink', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Unlink failed');
      }
      onUnlinked();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUnlinking(false);
    }
  }

  const allMembers = [{ projectId, name: projectName }, ...linkedProjects];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Shared Assets</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {sharedFolderName && (
          <p className="link-mgmt-folder">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            {sharedFolderName}
          </p>
        )}

        <div>
          <p className="link-mgmt-section-label">Projects sharing this folder</p>
          <ul className="link-mgmt-list">
            {allMembers.map((p) => (
              <li key={p.projectId} className={`link-mgmt-item${p.projectId === projectId ? ' link-mgmt-item--current' : ''}`}>
                <span className="link-mgmt-item-name">{p.name}</span>
                {p.projectId === projectId && <span className="link-mgmt-you">this project</span>}
              </li>
            ))}
          </ul>
        </div>

        {error && <p className="link-mgmt-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="modal-btn-danger"
            disabled={unlinking}
            onClick={() => void handleUnlink()}
          >
            {unlinking ? 'Unlinking…' : 'Unlink This Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
