'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskPriority } from '@/lib/models/task';
import type { TaskType } from '@/lib/models/task-phase';
import { resolveTaskTypeConfig } from '@/lib/models/task-phase';
import { STARTER_PLATFORM_CATEGORIES } from '@/lib/models/task-categories';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from './MentionTextarea';
import { usePreprodConfig } from './preprod-config-context';

interface Props {
  /** Distinct client names to populate the picker. "General" is added at the top
   *  automatically — callers don't need to include it. */
  clientNames: string[];
  users: UserSummary[];
  currentUserId: string;
  /** Optional. When set, the modal opens directly into that task-type's form
   *  (matches the previous /dashboard behavior). When omitted, the user picks
   *  a type via an internal three-button picker before the form appears —
   *  used by the people-page task icon for active clients ("no default"). */
  taskType?: TaskType;
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
  taskType: initialTaskType,
  defaultClientName,
  lockedClient,
  onCreated,
  onClose,
}: Readonly<Props>) {
  // Internal taskType state — starts from the caller's prop (when provided) or
  // null when the caller didn't pre-select. Null forces the picker step.
  const [taskType, setTaskTypeState] = useState<TaskType | null>(initialTaskType ?? null);
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
    if (!taskType || taskType !== 'platform') return;
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

  // Pre-Production statuses are DB-backed; usePreprodConfig is a no-op for
  // editing/platform (resolveTaskTypeConfig ignores the dynamic list for them).
  // When taskType is null (picker step) the resolve call falls back to a stub
  // config — submit is disabled until a type is picked anyway.
  const { statuses: preprodStatuses } = usePreprodConfig();
  const taskTypeConfig = taskType
    ? resolveTaskTypeConfig(taskType, preprodStatuses)
    : { value: 'editing' as TaskType, label: '', statuses: [], defaultStatus: '', terminalStatus: '' };
  const noPreprodColumns = taskType === 'preprod' && taskTypeConfig.statuses.length === 0;

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
    if (!taskType) { setError('Pick a task type first.'); return; }
    if (!description.trim()) { setError('Description is required.'); return; }
    if (noPreprodColumns) {
      setError('Pre-Production has no columns yet. Ask an admin to set them up first.');
      return;
    }
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
          <h2 className="modal-title">
            {taskType
              ? `New ${taskType === 'platform' ? 'Platform' : taskType === 'preprod' ? 'Pre-Production' : 'Editing'} Task`
              : 'New Task'}
          </h2>
          <button type="button" className="modal-close" onClick={handleClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          {/* Type picker — shown only when the caller didn't pre-select a
              taskType (e.g. people-page task icon on active clients). Once
              clicked, the rest of the form renders for that type's flow. */}
          {!taskType && (
            <div className="modal-field">
              <label className="modal-label">Task Type</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {(['preprod', 'editing', 'platform'] as TaskType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTaskTypeState(t)}
                    style={{
                      flex: 1, padding: '0.45rem 0', borderRadius: 6,
                      fontSize: '0.82rem', fontWeight: 600,
                      border: '1px solid var(--color-border,#444)',
                      background: 'transparent', color: 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {t === 'preprod' ? 'Pre-Production' : t === 'editing' ? 'Editing' : 'Platform'}
                  </button>
                ))}
              </div>
            </div>
          )}

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
          {noPreprodColumns && !error && (
            <p className="modal-error" style={{ opacity: 0.8 }}>
              Pre-Production has no columns yet. Open “Manage columns” on the board to add some, then try again.
            </p>
          )}

          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={handleClose} disabled={saving}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={saving || noPreprodColumns}>
              {saving ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
