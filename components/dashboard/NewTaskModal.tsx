'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskPriority } from '@/lib/models/task';
import type { TaskType } from '@/lib/models/task-phase';
import { getTaskTypeConfig } from '@/lib/models/task-phase';
import { STARTER_PLATFORM_CATEGORIES } from '@/lib/models/task-categories';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from './MentionTextarea';

interface Props {
  /** Distinct client names to populate the picker. "General" is added at the top
   *  automatically — callers don't need to include it. */
  clientNames: string[];
  users: UserSummary[];
  currentUserId: string;
  /** Required. The modal infers task type from caller context (Editing tab's
   *  Not Started column vs. Platform tab's top-level button); the user never
   *  picks it inside the modal. */
  taskType: TaskType;
  /** Pre-selects the client dropdown and locks it (e.g. when creating from a
   *  project-scoped surface where the client is already known). */
  defaultClientName?: string;
  lockedClient?: boolean;
  onCreated: (task: Task) => void;
  onClose: () => void;
}

export function NewTaskModal({
  clientNames,
  users,
  currentUserId,
  taskType,
  defaultClientName,
  lockedClient,
  onCreated,
  onClose,
}: Readonly<Props>) {
  const [description, setDescription] = useState('');
  const [clientName, setClientName] = useState<string>(defaultClientName ?? 'General');
  // Live category list, fetched once on mount. Falls back to the F2 hardcoded
  // starter set if the API is unreachable so the modal stays usable offline.
  const [categories, setCategories] = useState<string[]>(STARTER_PLATFORM_CATEGORIES);
  const [category, setCategory] = useState<string>(STARTER_PLATFORM_CATEGORIES[0] ?? '');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([currentUserId]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);

  // Only Platform tasks need the categories — skip the fetch for Editing.
  useEffect(() => {
    if (taskType !== 'platform') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/task-categories');
        if (!res.ok) return;
        const data = await res.json() as { categories?: Array<{ label: string }> };
        const labels = (data.categories ?? []).map((c) => c.label).filter(Boolean);
        if (!cancelled && labels.length > 0) {
          setCategories(labels);
          setCategory((cur) => labels.includes(cur) ? cur : labels[0]);
        }
      } catch {
        // Fall through to the hardcoded starter set
      }
    })();
    return () => { cancelled = true; };
  }, [taskType]);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 140);
  }

  const taskTypeConfig = getTaskTypeConfig(taskType);

  // "General" floats at the top; the rest are deduped and alphabetized.
  const clientOptions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const name of clientNames) {
      const trimmed = name?.trim();
      if (trimmed && trimmed !== 'General') set.add(trimmed);
    }
    return ['General', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [clientNames]);

  function toggleAssignee(uid: string) {
    setAssigneeIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) { setError('Description is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          clientName,
          taskType,
          category: taskType === 'platform' ? category : null,
          status: taskTypeConfig.defaultStatus,
          priority,
          assignedTo: assigneeIds.length > 0 ? assigneeIds : [currentUserId],
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to create task');
      }
      const data = await res.json() as { task: Task };
      onCreated(data.task);
      handleClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`} onClick={handleClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">New {taskType === 'platform' ? 'Platform' : 'Editing'} Task</h2>
          <button type="button" className="modal-close" onClick={handleClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="modal-field">
            <label className="modal-label" htmlFor="nt-client">Client</label>
            <select
              id="nt-client"
              className="modal-input modal-select"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              disabled={lockedClient}
              autoFocus={lockedClient}
            >
              {clientOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {taskType === 'platform' && (
            <div className="modal-field">
              <label className="modal-label" htmlFor="nt-category">Category</label>
              <select
                id="nt-category"
                className="modal-input modal-select"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          <div className="modal-field">
            <label className="modal-label" htmlFor="nt-desc">Description</label>
            <input
              id="nt-desc"
              className="modal-input"
              type="text"
              placeholder="What needs to be done?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus={!lockedClient}
              autoComplete="off"
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">Assignees</label>
            <div className="modal-assignee-list">
              {users.map((u) => (
                <label key={u.id} className="modal-assignee-option">
                  <input
                    type="checkbox"
                    checked={assigneeIds.includes(u.id)}
                    onChange={() => toggleAssignee(u.id)}
                  />
                  <span className="modal-assignee-name">{u.name}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="modal-field">
            <label className="modal-label" htmlFor="nt-priority">Priority</label>
            <select
              id="nt-priority"
              className="modal-input modal-select"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
            >
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div className="modal-field">
            <label className="modal-label" htmlFor="nt-notes">Notes</label>
            <MentionTextarea
              id="nt-notes"
              value={notes}
              onChange={setNotes}
              users={users}
              placeholder="Additional context… use @name to tag a teammate"
              rows={3}
            />
          </div>

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={handleClose} disabled={saving}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
