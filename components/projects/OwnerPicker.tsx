'use client';

import { useState } from 'react';
import type { UserSummary } from '@/lib/models/user';
import { OwnerAvatar } from './OwnerAvatar';

interface Props {
  clientName: string;
  currentOwnerId?: string;
  users: UserSummary[];
  onAssign: (userId: string) => Promise<void>;
  onClose: () => void;
}

export function OwnerPicker({ clientName, currentOwnerId, users, onAssign, onClose }: Props) {
  const [busy, setBusy] = useState(false);

  async function handleSelect(userId: string) {
    if (busy || userId === currentOwnerId) return;
    setBusy(true);
    try {
      await onAssign(userId);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{currentOwnerId ? 'Reassign Owner' : 'Assign Owner'}</h2>
            <p className="owner-picker-subtitle">{clientName}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="owner-picker-list">
          {users.map((user) => {
            const isActive = user.id === currentOwnerId;
            return (
              <button
                key={user.id}
                type="button"
                className={`owner-picker-item${isActive ? ' owner-picker-item--active' : ''}`}
                onClick={() => handleSelect(user.id)}
                disabled={busy}
              >
                <OwnerAvatar user={user} size={32} />
                <div className="owner-picker-info">
                  <span className="owner-picker-name">{user.name}</span>
                  <span className="owner-picker-email">{user.email}</span>
                </div>
                {isActive && (
                  <svg className="owner-picker-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
