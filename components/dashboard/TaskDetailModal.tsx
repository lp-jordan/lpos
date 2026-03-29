'use client';

import { useState } from 'react';
import type { Task, TaskStatus, TaskPriority } from '@/lib/models/task';
import type { Project } from '@/lib/models/project';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from './MentionTextarea';

interface Props {
  task: Task;
  projects: Project[];
  users: UserSummary[];
  onUpdated: (task: Task) => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  waiting_on_client: 'Waiting',
  done: 'Done',
};

const STATUS_ORDER: TaskStatus[] = ['not_started', 'in_progress', 'blocked', 'waiting_on_client', 'done'];

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function TaskDetailModal({ task, projects, users, onUpdated, onClose }: Readonly<Props>) {
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [statusOpen, setStatusOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dirty = status !== task.status || notes !== (task.notes ?? '');

  const project =
    task.projectId !== 'unassigned'
      ? projects.find((p) => p.projectId === task.projectId)
      : null;

  const assignees = users.filter((u) => task.assignedTo.includes(u.id));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/tasks/${task.taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, notes: notes.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to save');
      }
      const data = await res.json() as { task: Task };
      onUpdated(data.task);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box task-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{task.description}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="task-detail-body">
          <div className="task-detail-meta">

            <div className="task-detail-field">
              <span className="task-detail-label">Status</span>
              <div className="task-status-wrapper">
                <button
                  type="button"
                  className={`task-status-pill task-status-pill--${status}`}
                  onClick={() => setStatusOpen((v) => !v)}
                >
                  {STATUS_LABEL[status]}
                </button>
                {statusOpen && (
                  <div className="task-status-dropdown" onMouseLeave={() => setStatusOpen(false)}>
                    {STATUS_ORDER.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`task-status-option${s === status ? ' task-status-option--active' : ''}`}
                        onClick={() => { setStatus(s); setStatusOpen(false); }}
                      >
                        {STATUS_LABEL[s]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="task-detail-field">
              <span className="task-detail-label">Priority</span>
              <span className={`task-priority-badge task-priority-badge--${task.priority}`}>
                {PRIORITY_LABEL[task.priority]}
              </span>
            </div>

            {project && (
              <div className="task-detail-field">
                <span className="task-detail-label">Project</span>
                <span className="task-detail-value">
                  <strong className="task-detail-value-strong">{project.clientName}</strong>
                  {' — '}
                  {project.name}
                </span>
              </div>
            )}

            {assignees.length > 0 && (
              <div className="task-detail-field">
                <span className="task-detail-label">Assigned to</span>
                <span className="task-detail-value">{assignees.map((u) => u.name).join(', ')}</span>
              </div>
            )}

            <div className="task-detail-field">
              <span className="task-detail-label">Created</span>
              <span className="task-detail-value task-detail-value--muted">{relativeTime(task.createdAt)}</span>
            </div>

          </div>

          <div className="task-detail-notes-section">
            <span className="task-detail-label">Notes</span>
            <MentionTextarea
              value={notes}
              onChange={setNotes}
              users={users}
              placeholder="Add notes… use @name to tag a teammate"
              rows={4}
            />
          </div>
        </div>

        {error && <p className="modal-error" style={{ margin: '0 20px' }}>{error}</p>}

        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>
            {dirty ? 'Discard' : 'Close'}
          </button>
          {dirty && (
            <button
              type="button"
              className="modal-btn-primary"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
