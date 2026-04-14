'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task, TaskPriority } from '@/lib/models/task';
import type { TaskPhase } from '@/lib/models/task-phase';
import { PHASE_CONFIGS, getPhaseConfig } from '@/lib/models/task-phase';
import type { Project } from '@/lib/models/project';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from '@/components/dashboard/MentionTextarea';
import { CommentThread } from './CommentThread';

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

interface Props {
  task: Task;
  allProjects: Project[];
  users: UserSummary[];
  currentUserId: string;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  onClose: () => void;
}

export function TaskDetailModal({
  task,
  allProjects,
  users,
  currentUserId,
  onUpdated,
  onDeleted,
  onClose,
}: Readonly<Props>) {
  const [title, setTitle] = useState(task.description);
  const [phase, setPhase] = useState<TaskPhase>(task.phase);
  const [status, setStatus] = useState(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(task.assignedTo);
  const [projectId, setProjectId] = useState(task.projectId ?? 'general');
  const [notes, setNotes] = useState(task.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const assigneeRef = useRef<HTMLDivElement>(null);

  const phaseConfig = getPhaseConfig(phase);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 140);
  }

  // Reset state when task changes
  useEffect(() => {
    setTitle(task.description);
    setPhase(task.phase);
    setStatus(task.status);
    setPriority(task.priority);
    setAssigneeIds(task.assignedTo);
    setProjectId(task.projectId ?? 'general');
    setNotes(task.notes ?? '');
    setConfirmDelete(false);
  }, [task.taskId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  function handlePhaseChange(p: TaskPhase) {
    const nextDefault = getPhaseConfig(p).defaultStatus;
    setPhase(p);
    setStatus(nextDefault);
    void patch({ phase: p, status: nextDefault });
  }

  function handleStatusChange(s: string) {
    setStatus(s);
    void patch({ status: s });
  }

  function handlePriorityChange(p: TaskPriority) {
    setPriority(p);
    void patch({ priority: p });
  }

  function handleProjectChange(pid: string) {
    setProjectId(pid);
    void patch({ projectId: pid });
  }

  function handleNotesBlur() {
    if (notes !== (task.notes ?? '')) {
      void patch({ notes: notes.trim() || null });
    }
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
              <span className="task-detail-label">Phase</span>
              <select
                className="task-panel-select"
                value={phase}
                onChange={(e) => handlePhaseChange(e.target.value as TaskPhase)}
              >
                {PHASE_CONFIGS.map((c) => (
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
                {phaseConfig.statuses.map((s) => (
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
              <span className="task-detail-label">Project</span>
              <select
                className="task-panel-select"
                value={projectId}
                onChange={(e) => handleProjectChange(e.target.value)}
              >
                <option value="general">General</option>
                {allProjects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.clientName} — {p.name}
                  </option>
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

          {/* Notes */}
          <div className="task-panel-notes">
            <span className="task-detail-label">Notes</span>
            <MentionTextarea
              value={notes}
              onChange={setNotes}
              onBlur={handleNotesBlur}
              users={users}
              placeholder="Add context… @mention a teammate"
              rows={3}
            />
          </div>

          {/* Comments */}
          <CommentThread taskId={task.taskId} currentUserId={currentUserId} users={users} />
        </div>
      </div>
    </div>
  );
}
