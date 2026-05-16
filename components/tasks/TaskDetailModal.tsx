'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskPriority } from '@/lib/models/task';
import type { TaskType } from '@/lib/models/task-phase';
import { TASK_TYPE_CONFIGS, getTaskTypeConfig } from '@/lib/models/task-phase';
import type { UserSummary } from '@/lib/models/user';
import { CommentThread } from './CommentThread';

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

interface Props {
  task: Task;
  users: UserSummary[];
  /** Distinct client names from active projects. "General" is added at the top
   *  inside the modal so callers don't need to include it. */
  clientNames: string[];
  currentUserId: string;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  onClose: () => void;
}

export function TaskDetailModal({
  task,
  users,
  clientNames,
  currentUserId,
  onUpdated,
  onDeleted,
  onClose,
}: Readonly<Props>) {
  const [title, setTitle] = useState(task.description);
  const [taskType, setTaskType] = useState<TaskType>(task.taskType);
  const [status, setStatus] = useState(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [clientName, setClientName] = useState<string>(task.clientName || 'General');
  const [assigneeIds, setAssigneeIds] = useState<string[]>(task.assignedTo);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const assigneeRef = useRef<HTMLDivElement>(null);

  const taskTypeConfig = getTaskTypeConfig(taskType);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 140);
  }

  // Reset state when task changes
  useEffect(() => {
    setTitle(task.description);
    setTaskType(task.taskType);
    setStatus(task.status);
    setPriority(task.priority);
    setClientName(task.clientName || 'General');
    setAssigneeIds(task.assignedTo);
    setConfirmDelete(false);
  }, [task.taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // "General" floats at the top; everything else deduped + alphabetized.
  // Mirrors the NewTaskModal options shape so the same client list is shown
  // in both surfaces.
  const clientOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const name of clientNames) {
      const trimmed = name?.trim();
      if (trimmed && trimmed !== 'General') set.add(trimmed);
    }
    // Include the task's current client even if it's no longer in the active
    // projects list — so renaming a project doesn't silently strand a task.
    if (task.clientName && task.clientName !== 'General') set.add(task.clientName);
    return ['General', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [clientNames, task.clientName]);

  // Close assignee dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!assigneeRef.current?.contains(e.target as Node)) setAssigneeOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = useCallback(async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/tasks/${task.taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json() as { task: Task };
        onUpdated(data.task);
        return data.task;
      }
    } finally {
      setSaving(false);
    }
    return null;
  }, [task.taskId, onUpdated]);

  function handleTitleBlur() {
    if (title.trim() && title.trim() !== task.description) {
      void patch({ description: title.trim() });
    }
  }

  function handleTaskTypeChange(t: TaskType) {
    const nextDefault = getTaskTypeConfig(t).defaultStatus;
    setTaskType(t);
    setStatus(nextDefault);
    void patch({ taskType: t, status: nextDefault });
  }

  function handleStatusChange(s: string) {
    setStatus(s);
    void patch({ status: s });
  }

  function handlePriorityChange(p: TaskPriority) {
    setPriority(p);
    void patch({ priority: p });
  }

  function handleClientChange(c: string) {
    setClientName(c);
    void patch({ clientName: c });
  }

  function toggleAssignee(uid: string) {
    const next = assigneeIds.includes(uid)
      ? assigneeIds.filter((id) => id !== uid)
      : [...assigneeIds, uid];
    setAssigneeIds(next);
    void patch({ assignedTo: next });
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    const res = await fetch(`/api/tasks/${task.taskId}`, { method: 'DELETE' });
    if (res.ok) onDeleted(task.taskId);
  }

  const assignees = users.filter((u) => assigneeIds.includes(u.id));

  return (
    <div className={`modal-overlay task-detail-overlay${closing ? ' modal-overlay--closing' : ''}`} onClick={handleClose}>
      <div className="modal-box task-detail-box" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="task-detail-header">
          <input
            className="task-detail-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            placeholder="Task title"
          />
          <div className="task-detail-header-actions">
            {saving && <span className="task-detail-saving">Saving…</span>}
            <button
              type="button"
              className={`task-panel-delete-btn${confirmDelete ? ' task-panel-delete-btn--confirm' : ''}`}
              onClick={() => void handleDelete()}
              title={confirmDelete ? 'Click again to confirm delete' : 'Delete task'}
            >
              {confirmDelete ? 'Delete?' : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4h6v2" />
                </svg>
              )}
            </button>
            <button type="button" className="modal-close" onClick={handleClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="task-detail-body">
          {/* Meta */}
          <div className="task-detail-meta">
            <div className="task-detail-field">
              <span className="task-detail-label">Type</span>
              <select
                className="task-panel-select"
                value={taskType}
                onChange={(e) => handleTaskTypeChange(e.target.value as TaskType)}
              >
                {TASK_TYPE_CONFIGS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <div className="task-detail-field">
              <span className="task-detail-label">Status</span>
              <select
                className="task-panel-select"
                value={status}
                onChange={(e) => handleStatusChange(e.target.value)}
              >
                {taskTypeConfig.statuses.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <div className="task-detail-field">
              <span className="task-detail-label">Priority</span>
              <select
                className={`task-panel-select task-priority-select--${priority}`}
                value={priority}
                onChange={(e) => handlePriorityChange(e.target.value as TaskPriority)}
              >
                {PRIORITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="task-detail-field">
              <span className="task-detail-label">Client</span>
              <select
                className="task-panel-select"
                value={clientName}
                onChange={(e) => handleClientChange(e.target.value)}
              >
                {clientOptions.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="task-detail-field task-detail-field--assignees" ref={assigneeRef}>
              <span className="task-detail-label">Assigned to</span>
              <button
                type="button"
                className="task-panel-assignee-trigger"
                onClick={() => setAssigneeOpen((v) => !v)}
              >
                {assignees.length === 0
                  ? <span className="task-panel-assignee-none">Unassigned</span>
                  : assignees.map((u) => (
                    <span key={u.id} className="task-panel-assignee-chip">{u.name.split(' ')[0]}</span>
                  ))}
                <span className="task-panel-assignee-caret">▾</span>
              </button>
              {assigneeOpen && (
                <div className="task-panel-assignee-dropdown">
                  {users.map((u) => (
                    <label key={u.id} className="task-panel-assignee-option">
                      <input
                        type="checkbox"
                        checked={assigneeIds.includes(u.id)}
                        onChange={() => toggleAssignee(u.id)}
                      />
                      <span>{u.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Updates (formerly Notes + Comments) — single chronological thread */}
          <CommentThread taskId={task.taskId} currentUserId={currentUserId} users={users} />
        </div>
      </div>
    </div>
  );
}
