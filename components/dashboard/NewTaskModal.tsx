'use client';

import { useState } from 'react';
import type { Project } from '@/lib/models/project';
import type { Task, TaskPriority } from '@/lib/models/task';
import type { UserSummary } from '@/lib/models/user';
import { MentionTextarea } from './MentionTextarea';

interface Props {
  projects: Project[];
  users: UserSummary[];
  currentUserId: string;
  defaultProjectId?: string;
  onCreated: (task: Task) => void;
  onClose: () => void;
}

export function NewTaskModal({
  projects,
  users,
  currentUserId,
  defaultProjectId,
  onCreated,
  onClose,
}: Readonly<Props>) {
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [assigneeId, setAssigneeId] = useState(currentUserId);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Group projects by client for the <optgroup> picker
  const clientMap = new Map<string, Project[]>();
  for (const p of projects) {
    if (!clientMap.has(p.clientName)) clientMap.set(p.clientName, []);
    clientMap.get(p.clientName)!.push(p);
  }

  const lockedProject = !!defaultProjectId;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) { setError('Description is required.'); return; }
    if (!projectId) { setError('Project is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const project = projects.find((p) => p.projectId === projectId);
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          projectId,
          clientName: project?.clientName ?? null,
          priority,
          assignedTo: [assigneeId],
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to create task');
      }
      const data = await res.json() as { task: Task };
      onCreated(data.task);
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
          <h2 className="modal-title">New Task</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="modal-field">
            <label className="modal-label" htmlFor="nt-desc">Description</label>
            <input
              id="nt-desc"
              className="modal-input"
              type="text"
              placeholder="What needs to be done?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus={!lockedProject}
              autoComplete="off"
            />
          </div>

          <div className="modal-field">
            <label className="modal-label" htmlFor="nt-project">Project</label>
            <select
              id="nt-project"
              className="modal-input modal-select"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={lockedProject}
              autoFocus={lockedProject}
            >
              {!lockedProject && <option value="">— Select a project —</option>}
              {[...clientMap.entries()].map(([client, clientProjects]) => (
                <optgroup key={client} label={client}>
                  {clientProjects.map((p) => (
                    <option key={p.projectId} value={p.projectId}>{p.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="modal-field-row">
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
              <label className="modal-label" htmlFor="nt-assignee">Assignee</label>
              <select
                id="nt-assignee"
                className="modal-input modal-select"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
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
            <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
