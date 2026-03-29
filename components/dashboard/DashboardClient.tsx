'use client';

import { useCallback, useState } from 'react';
import type { Project } from '@/lib/models/project';
import { SUBPHASE_ORDER, SUBPHASE_PHASE_MAP } from '@/lib/models/project';
import type { Task, TaskStatus, TaskPriority } from '@/lib/models/task';
import type { ProjectNote } from '@/lib/models/project-note';
import type { UserSummary } from '@/lib/models/user';
import { NewTaskModal } from './NewTaskModal';
import { TaskDetailModal } from './TaskDetailModal';

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

/** Highlight @word tokens in notes text. */
function renderNotes(text: string) {
  const parts = text.split(/(@\w+)/g);
  return parts.map((part, i) =>
    part.startsWith('@')
      ? <span key={i} className="task-mention">{part}</span>
      : part,
  );
}

// ── Status ────────────────────────────────────────────────────────────────────

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

// ── Activity ──────────────────────────────────────────────────────────────────

interface ActivityEvent {
  event_id: string;
  occurred_at: string;
  event_type: string;
  title: string;
  summary: string | null;
  project_id: string | null;
  actor_display: string | null;
  actor_type: string | null;
}

function ActivityFeed({ events, projectMap }: { events: ActivityEvent[]; projectMap: Map<string, string> }) {
  if (events.length === 0) {
    return <p className="dashboard-empty">No recent activity for your projects.</p>;
  }
  return (
    <ul className="dashboard-activity-list">
      {events.map((e) => {
        const projectName = e.project_id ? (projectMap.get(e.project_id) ?? null) : null;
        const showActor = e.actor_display && e.actor_type !== 'system';
        return (
          <li key={e.event_id} className="dashboard-activity-item">
            <span className="dashboard-activity-title">{e.title}</span>
            <span className="dashboard-activity-meta">
              {projectName && (
                <span className="dashboard-activity-project">{projectName}</span>
              )}
              {showActor && (
                <span className="dashboard-activity-actor">{e.actor_display}</span>
              )}
              <span className="dashboard-activity-time">{relativeTime(e.occurred_at)}</span>
            </span>
          </li>
        );
      })}
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

function StatusPill({ task, onChange }: { task: Task; onChange: (status: TaskStatus) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="task-status-wrapper" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`task-status-pill task-status-pill--${task.status}`}
        onClick={() => setOpen((v) => !v)}
      >
        {STATUS_LABEL[task.status]}
      </button>
      {open && (
        <div className="task-status-dropdown" onMouseLeave={() => setOpen(false)}>
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={`task-status-option${s === task.status ? ' task-status-option--active' : ''}`}
              onClick={() => { onChange(s); setOpen(false); }}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TodoSection({
  initialTasks,
  userId,
  allProjects,
  users,
}: {
  initialTasks: Task[];
  userId: string;
  allProjects: Project[];
  users: UserSummary[];
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [showModal, setShowModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [collapsedDone, setCollapsedDone] = useState<Record<string, boolean>>({});

  const projectMap = new Map(allProjects.map((p) => [p.projectId, p]));

  const setStatus = useCallback(async (task: Task, status: TaskStatus) => {
    const res = await fetch(`/api/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const data = await res.json() as { task: Task };
      setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? data.task : t));
    }
  }, []);

  const activeTasks = tasks.filter((t) => t.status !== 'done');
  const doneTasks = tasks.filter((t) => t.status === 'done');

  // Group active tasks by projectId
  const groups = new Map<string, Task[]>();
  for (const t of activeTasks) {
    if (!groups.has(t.projectId)) groups.set(t.projectId, []);
    groups.get(t.projectId)!.push(t);
  }
  // Done tasks also grouped
  const doneGroups = new Map<string, Task[]>();
  for (const t of doneTasks) {
    if (!doneGroups.has(t.projectId)) doneGroups.set(t.projectId, []);
    doneGroups.get(t.projectId)!.push(t);
  }

  const allGroupIds = [...new Set([...groups.keys(), ...doneGroups.keys()])];

  function projectLabel(projectId: string): string {
    const p = projectMap.get(projectId);
    if (!p) return projectId === 'unassigned' ? 'Unassigned' : projectId;
    return `${p.clientName} — ${p.name}`;
  }

  if (tasks.length === 0 && !showModal) {
    return (
      <div>
        <p className="dashboard-empty">No tasks yet.</p>
        <button type="button" className="dashboard-add-btn" onClick={() => setShowModal(true)}>+ New Task</button>
        {showModal && (
          <NewTaskModal
            projects={allProjects}
            users={users}
            currentUserId={userId}
            onCreated={(t) => setTasks((prev) => [t, ...prev])}
            onClose={() => setShowModal(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="dashboard-todos">
      {allGroupIds.map((pid) => {
        const activeGroup = groups.get(pid) ?? [];
        const doneGroup = doneGroups.get(pid) ?? [];
        const doneCollapsed = collapsedDone[pid] !== false; // collapsed by default

        return (
          <div key={pid} className="task-group">
            <div className="task-group-header">{projectLabel(pid)}</div>

            {activeGroup.map((t) => (
              <TaskRow key={t.taskId} task={t} onStatusChange={(s) => void setStatus(t, s)} onClick={() => setSelectedTask(t)} />
            ))}

            {doneGroup.length > 0 && (
              <>
                <button
                  type="button"
                  className="task-done-toggle"
                  onClick={() => setCollapsedDone((prev) => ({ ...prev, [pid]: !doneCollapsed }))}
                >
                  {doneCollapsed ? '▸' : '▾'} {doneGroup.length} completed
                </button>
                {!doneCollapsed && doneGroup.map((t) => (
                  <TaskRow key={t.taskId} task={t} onStatusChange={(s) => void setStatus(t, s)} onClick={() => setSelectedTask(t)} />
                ))}
              </>
            )}
          </div>
        );
      })}

      <button type="button" className="dashboard-add-btn" onClick={() => setShowModal(true)}>
        + New Task
      </button>

      {showModal && (
        <NewTaskModal
          projects={allProjects}
          users={users}
          currentUserId={userId}
          onCreated={(t) => setTasks((prev) => [t, ...prev])}
          onClose={() => setShowModal(false)}
        />
      )}

      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          projects={allProjects}
          users={users}
          onUpdated={(updated) => setTasks((prev) => prev.map((t) => t.taskId === updated.taskId ? updated : t))}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  );
}

function TaskRow({ task, onStatusChange, onClick }: { task: Task; onStatusChange: (s: TaskStatus) => void; onClick: () => void }) {
  return (
    <div
      className={`task-row${task.status === 'done' ? ' task-row--done' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <StatusPill task={task} onChange={onStatusChange} />
      <div className="task-body">
        <span className="task-desc">{task.description}</span>
        {task.notes && (
          <span className="task-notes">{renderNotes(task.notes)}</span>
        )}
      </div>
      {task.priority !== 'medium' && (
        <span className={`task-priority-badge task-priority-badge--${task.priority}`}>
          {PRIORITY_LABEL[task.priority]}
        </span>
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
  allProjects: Project[];
  users: UserSummary[];
  activity: ActivityEvent[];
  tasks: Task[];
  notes: ProjectNote[];
  userMap: Record<string, string>;
}

export function DashboardClient({
  firstName,
  userId,
  projects,
  allProjects,
  users,
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
          <ActivityFeed
            events={activity}
            projectMap={new Map(allProjects.map((p) => [p.projectId, p.name]))}
          />
        </section>

        <section className="dashboard-section">
          <h2 className="dashboard-section-heading">To-Dos</h2>
          <TodoSection
            initialTasks={tasks}
            userId={userId}
            allProjects={allProjects}
            users={users}
          />
        </section>

        <section className="dashboard-section">
          <h2 className="dashboard-section-heading">Handoff Notes</h2>
          <NotesSection initialNotes={notes} userMap={userMap} />
        </section>
      </div>
    </div>
  );
}
