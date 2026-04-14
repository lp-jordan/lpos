'use client';

import { useEffect, useRef, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';

interface Props {
  x: number;
  y: number;
  taskId: string;
  assignedTo: string[];
  users: UserSummary[];
  onRename: () => void;
  onReassign: (userIds: string[]) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TaskContextMenu({
  x,
  y,
  assignedTo,
  users,
  onRename,
  onReassign,
  onDelete,
  onClose,
}: Readonly<Props>) {
  const [mode, setMode] = useState<'root' | 'reassign' | 'confirm_delete'>('root');
  const [assigneeIds, setAssigneeIds] = useState<string[]>(assignedTo);
  const menuRef = useRef<HTMLDivElement>(null);

  // Clamp to viewport
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 8),
      y: Math.min(y, window.innerHeight - rect.height - 8),
    });
  }, [x, y, mode]);

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  function toggleAssignee(uid: string) {
    const next = assigneeIds.includes(uid)
      ? assigneeIds.filter((id) => id !== uid)
      : [...assigneeIds, uid];
    setAssigneeIds(next);
    onReassign(next);
  }

  return (
    <div
      ref={menuRef}
      className="task-ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {mode === 'root' && (
        <>
          <button type="button" className="task-ctx-item" onClick={() => { onRename(); onClose(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Rename
          </button>
          <button type="button" className="task-ctx-item" onClick={() => setMode('reassign')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Reassign
            <span className="task-ctx-chevron">›</span>
          </button>
          <div className="task-ctx-divider" />
          <button type="button" className="task-ctx-item task-ctx-item--danger" onClick={() => setMode('confirm_delete')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6M9 6V4h6v2" />
            </svg>
            Delete
          </button>
        </>
      )}

      {mode === 'reassign' && (
        <>
          <div className="task-ctx-back-row">
            <button type="button" className="task-ctx-back" onClick={() => setMode('root')}>‹ Back</button>
            <span className="task-ctx-section-label">Assignees</span>
          </div>
          <div className="task-ctx-user-list">
            {users.map((u) => (
              <label key={u.id} className="task-ctx-user-option">
                <input
                  type="checkbox"
                  checked={assigneeIds.includes(u.id)}
                  onChange={() => toggleAssignee(u.id)}
                />
                <span>{u.name}</span>
              </label>
            ))}
          </div>
        </>
      )}

      {mode === 'confirm_delete' && (
        <>
          <p className="task-ctx-confirm-text">Delete this task?</p>
          <div className="task-ctx-confirm-actions">
            <button type="button" className="task-ctx-cancel" onClick={() => setMode('root')}>Cancel</button>
            <button type="button" className="task-ctx-confirm-delete" onClick={() => { onDelete(); onClose(); }}>Delete</button>
          </div>
        </>
      )}
    </div>
  );
}
