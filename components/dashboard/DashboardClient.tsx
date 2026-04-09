'use client';

import { useCallback, useState } from 'react';
import type { Project } from '@/lib/models/project';
import { SUBPHASE_ORDER, SUBPHASE_PHASE_MAP } from '@/lib/models/project';
import type { Task } from '@/lib/models/task';
import type { ProjectNote } from '@/lib/models/project-note';
import type { UserSummary } from '@/lib/models/user';
import { TaskBoard } from '@/components/tasks/TaskBoard';

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

function prevSubPhase(current: string): { phase: string; subPhase: string } | null {
  const idx = SUBPHASE_ORDER.indexOf(current as never);
  if (idx <= 0) return null;
  const prev = SUBPHASE_ORDER[idx - 1];
  return { phase: SUBPHASE_PHASE_MAP[prev as keyof typeof SUBPHASE_PHASE_MAP], subPhase: prev };
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
    <div className="dashboard-activity-scroll">
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
    </div>
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

  const retreat = useCallback(async (projectId: string, currentSubPhase: string) => {
    const prev = prevSubPhase(currentSubPhase);
    if (!prev) return;
    const res = await fetch(`/api/projects/${projectId}/phase`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prev),
    });
    if (res.ok) {
      const data = await res.json() as { project: Project };
      setProjects((p) => p.map((proj) => proj.projectId === projectId ? data.project : proj));
    }
  }, []);

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
                    {prevSubPhase(p.subPhase) && (
                      <button
                        type="button"
                        className="dashboard-advance-btn dashboard-advance-btn--back"
                        title={`Move back to ${SUBPHASE_LABEL[prevSubPhase(p.subPhase)?.subPhase ?? ''] ?? 'previous stage'}`}
                        onClick={() => void retreat(p.projectId, p.subPhase)}
                      >
                        ‹
                      </button>
                    )}
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
  commentCounts: Record<string, number>;
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
  commentCounts,
  notes,
  userMap,
}: DashboardClientProps) {
  return (
    <div className="page-stack">
      <div className="dashboard-header">
        <h1 className="dashboard-title">My Dashboard</h1>
        <p className="dashboard-subtitle">Welcome back, {firstName}.</p>
      </div>

      {/* Primary workspace: full-width Kanban board */}
      <section className="dashboard-board-section">
        <TaskBoard
          initialTasks={tasks}
          allProjects={allProjects}
          users={users}
          currentUserId={userId}
          commentCounts={commentCounts}
        />
      </section>

      {/* Secondary sidebar: Project Status + Activity + Handoff Notes */}
      <div className="dashboard-sidebar-row">
        <section className="dashboard-sidebar-section">
          <h2 className="dashboard-section-heading">Project Status</h2>
          <ProjectStatusSection initialProjects={projects} />
        </section>

        <section className="dashboard-sidebar-section">
          <h2 className="dashboard-section-heading">Recent Activity</h2>
          <ActivityFeed
            events={activity}
            projectMap={new Map(allProjects.map((p) => [p.projectId, p.name]))}
          />
        </section>

        <section className="dashboard-sidebar-section">
          <h2 className="dashboard-section-heading">Handoff Notes</h2>
          <NotesSection initialNotes={notes} userMap={userMap} />
        </section>
      </div>
    </div>
  );
}
