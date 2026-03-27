'use client';

import { useCallback, useState } from 'react';
import type { Project } from '@/lib/models/project';
import { SUBPHASE_ORDER, SUBPHASE_PHASE_MAP } from '@/lib/models/project';
import type { Task } from '@/lib/models/task';
import type { ProjectNote } from '@/lib/models/project-note';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const PHASE_LABEL: Record<string, string> = {
  pre_production: 'Pre-Production',
  production: 'Production',
  post_production: 'Post-Production',
};

const SUBPHASE_LABEL: Record<string, string> = {
  discovery: 'Discovery',
  blueprint: 'Blueprint',
  recording: 'Recording',
  editing: 'Editing',
  pass: 'Pass',
  workbooks: 'Workbooks',
};

function nextSubPhase(current: string): { phase: string; subPhase: string } | null {
  const idx = SUBPHASE_ORDER.indexOf(current as never);
  if (idx === -1 || idx === SUBPHASE_ORDER.length - 1) return null;
  const next = SUBPHASE_ORDER[idx + 1];
  return { phase: SUBPHASE_PHASE_MAP[next], subPhase: next };
}

function isCrossPhase(current: string): boolean {
  const next = nextSubPhase(current);
  if (!next) return false;
  return SUBPHASE_PHASE_MAP[current as never] !== next.phase;
}

// ── Activity ──────────────────────────────────────────────────────────────────

interface ActivityEvent {
  event_id: string;
  occurred_at: string;
  title: string;
  summary: string | null;
  project_id: string | null;
}

function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return <p className="dashboard-empty">No recent activity for your projects.</p>;
  }
  return (
    <ul className="dashboard-activity-list">
      {events.map((e) => (
        <li key={e.event_id} className="dashboard-activity-item">
          <span className="dashboard-activity-title">{e.title}</span>
          <span className="dashboard-activity-time">{relativeTime(e.occurred_at)}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Project Status ────────────────────────────────────────────────────────────

function ProjectStatusSection({ initialProjects }: { initialProjects: Project[] }) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [confirming, setConfirming] = useState<string | null>(null);

  const advance = useCallback(async (projectId: string, currentSubPhase: string) => {
    const next = nextSubPhase(currentSubPhase);
    if (!next) return;

    const crossPhase = isCrossPhase(currentSubPhase);
    if (crossPhase && confirming !== projectId) {
      setConfirming(projectId);
      return;
    }

    setConfirming(null);
    const res = await fetch(`/api/projects/${projectId}/phase`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (res.ok) {
      const data = await res.json() as { project: Project };
      setProjects((prev) => prev.map((p) => p.projectId === projectId ? data.project : p));
    }
  }, [confirming]);

  const byPhase = (phase: string) => projects.filter((p) => p.phase === phase);

  if (projects.length === 0) {
    return <p className="dashboard-empty">No active projects for your clients.</p>;
  }

  return (
    <div className="dashboard-project-phases">
      {(['pre_production', 'production', 'post_production'] as const).map((phase) => {
        const group = byPhase(phase);
        if (group.length === 0) return null;
        return (
          <div key={phase} className="dashboard-phase-group">
            <div className="dashboard-phase-label">{PHASE_LABEL[phase]}</div>
            {group.map((p) => {
              const hasNext = !!nextSubPhase(p.subPhase);
              const isConfirming = confirming === p.projectId;
              return (
                <div key={p.projectId} className="dashboard-project-row">
                  <div className="dashboard-project-info">
                    <span className="dashboard-project-name">{p.name}</span>
                    <span className="dashboard-project-client">{p.clientName}</span>
                  </div>
                  <div className="dashboard-project-right">
                    <span className={`dashboard-subphase-badge dashboard-subphase-badge--${p.phase}`}>
                      {SUBPHASE_LABEL[p.subPhase] ?? p.subPhase}
                    </span>
                    {hasNext && (
                      isConfirming ? (
                        <span className="dashboard-advance-confirm">
                          <button
                            type="button"
                            className="dashboard-advance-btn dashboard-advance-btn--confirm"
                            onClick={() => void advance(p.projectId, p.subPhase)}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="dashboard-advance-btn dashboard-advance-btn--cancel"
                            onClick={() => setConfirming(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="dashboard-advance-btn"
                          title={`Advance to ${SUBPHASE_LABEL[nextSubPhase(p.subPhase)?.subPhase ?? ''] ?? 'next stage'}`}
                          onClick={() => void advance(p.projectId, p.subPhase)}
                        >
                          ›
                        </button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── To-Dos ────────────────────────────────────────────────────────────────────

function TodoSection({ initialTasks, userId }: { initialTasks: Task[]; userId: string }) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);

  const toggle = useCallback(async (task: Task) => {
    const res = await fetch(`/api/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: !task.completed }),
    });
    if (res.ok) {
      const data = await res.json() as { task: Task };
      setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? data.task : t));
    }
  }, []);

  const submit = useCallback(async () => {
    if (!newDesc.trim()) return;
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: newDesc.trim() }),
    });
    if (res.ok) {
      const data = await res.json() as { task: Task };
      setTasks((prev) => [data.task, ...prev]);
      setNewDesc('');
      setAdding(false);
    }
  }, [newDesc]);

  const active = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed);

  return (
    <div className="dashboard-todos">
      {active.length === 0 && !adding && (
        <p className="dashboard-empty">No open to-dos.</p>
      )}
      {active.map((t) => (
        <label key={t.taskId} className="dashboard-todo-row">
          <input
            type="checkbox"
            className="dashboard-todo-check"
            checked={false}
            onChange={() => void toggle(t)}
          />
          <span className="dashboard-todo-desc">{t.description}</span>
          {t.clientName && <span className="dashboard-todo-client">{t.clientName}</span>}
        </label>
      ))}
      {done.slice(0, 3).map((t) => (
        <label key={t.taskId} className="dashboard-todo-row dashboard-todo-row--done">
          <input
            type="checkbox"
            className="dashboard-todo-check"
            checked
            onChange={() => void toggle(t)}
          />
          <span className="dashboard-todo-desc">{t.description}</span>
        </label>
      ))}
      {adding ? (
        <div className="dashboard-todo-add-row">
          <input
            autoFocus
            type="text"
            className="dashboard-todo-input"
            placeholder="Task description…"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') { setAdding(false); setNewDesc(''); }
            }}
          />
          <button type="button" className="dashboard-todo-save" onClick={() => void submit()}>Add</button>
          <button type="button" className="dashboard-todo-cancel" onClick={() => { setAdding(false); setNewDesc(''); }}>✕</button>
        </div>
      ) : (
        <button type="button" className="dashboard-add-btn" onClick={() => setAdding(true)}>
          + Add task
        </button>
      )}
    </div>
  );
}

// ── Handoff Notes ─────────────────────────────────────────────────────────────

function NotesSection({
  initialNotes,
  userMap,
}: {
  initialNotes: ProjectNote[];
  userMap: Record<string, string>;
}) {
  const [notes, setNotes] = useState<ProjectNote[]>(initialNotes);

  const resolve = useCallback(async (note: ProjectNote) => {
    const res = await fetch(`/api/projects/${note.projectId}/notes/${note.noteId}`, {
      method: 'PATCH',
    });
    if (res.ok) {
      setNotes((prev) => prev.filter((n) => n.noteId !== note.noteId));
    }
  }, []);

  if (notes.length === 0) {
    return <p className="dashboard-empty">No unresolved handoff notes.</p>;
  }

  return (
    <div className="dashboard-notes">
      {notes.map((n) => {
        const author = userMap[n.createdBy] ?? 'Someone';
        return (
          <div key={n.noteId} className="dashboard-note-card">
            <div className="dashboard-note-meta">
              <span className="dashboard-note-project">{n.clientName}</span>
              <span className="dashboard-note-author">from {author}</span>
              <span className="dashboard-note-time">{relativeTime(n.createdAt)}</span>
            </div>
            <p className="dashboard-note-body">{n.body}</p>
            <button
              type="button"
              className="dashboard-note-resolve"
              onClick={() => void resolve(n)}
            >
              Mark resolved
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export interface DashboardClientProps {
  firstName: string;
  userId: string;
  projects: Project[];
  activity: ActivityEvent[];
  tasks: Task[];
  notes: ProjectNote[];
  userMap: Record<string, string>;  // userId → display name
}

export function DashboardClient({
  firstName,
  userId,
  projects,
  activity,
  tasks,
  notes,
  userMap,
}: DashboardClientProps) {
  return (
    <div className="page-stack">
      <div className="dashboard-header">
        <h1 className="dashboard-title">My Dashboard</h1>
        <p className="dashboard-subtitle">Welcome back, {firstName}.</p>
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-section">
          <h2 className="dashboard-section-heading">Project Status</h2>
          <ProjectStatusSection initialProjects={projects} />
        </section>

        <section className="dashboard-section">
          <h2 className="dashboard-section-heading">Recent Activity</h2>
          <ActivityFeed events={activity} />
        </section>

        <section className="dashboard-section">
          <h2 className="dashboard-section-heading">To-Dos</h2>
          <TodoSection initialTasks={tasks} userId={userId} />
        </section>

        <section className="dashboard-section">
          <h2 className="dashboard-section-heading">Handoff Notes</h2>
          <NotesSection initialNotes={notes} userMap={userMap} />
        </section>
      </div>
    </div>
  );
}
