import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import type { ActivityActor } from '@/lib/models/activity';
import type { Project } from '@/lib/models/project';
import { recordActivity, systemActor } from '@/lib/services/activity-monitor-service';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureProjectDirs(projectId: string) {
  const base = path.join(DATA_DIR, 'projects', projectId);
  for (const sub of ['media', 'transcripts', 'subtitles', 'scripts', 'jobs', 'slate-notes']) {
    ensureDir(path.join(base, sub));
  }
}

export interface CreateProjectInput {
  name: string;
  clientName: string;
}

interface ActivityContext {
  actor?: ActivityActor;
  source_kind?: 'api' | 'ui' | 'background_service' | 'manual_admin';
}

export class ProjectStore {
  private projects: Project[] = [];
  private io: SocketIOServer | undefined;

  constructor(io?: SocketIOServer) {
    this.io = io;
    ensureDir(DATA_DIR);
    this.load();
  }

  /** Attach (or re-attach) the Socket.io server after lazy init. */
  attachIo(io: SocketIOServer) {
    this.io = io;
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private load() {
    if (!fs.existsSync(PROJECTS_FILE)) { this.projects = []; return; }
    try {
      const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')) as Project[];
      // Silent migration: backfill phase/subPhase for projects created before this feature.
      this.projects = raw.map((p) => ({
        phase: 'pre_production' as const,
        subPhase: 'discovery' as const,
        ...p,
      }));
    } catch {
      this.projects = [];
    }
  }

  private persist() {
    ensureDir(DATA_DIR);
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(this.projects, null, 2));
  }

  private broadcast() {
    this.io?.emit('projects:changed', this.projects);
  }

  // ── Read ───────────────────────────────────────────────────────────────

  getAll(): Project[] {
    return [...this.projects];
  }

  getById(projectId: string): Project | null {
    return this.projects.find((p) => p.projectId === projectId) ?? null;
  }

  // ── Write ──────────────────────────────────────────────────────────────

  create(input: CreateProjectInput, context?: ActivityContext): Project {
    const now = new Date();
    const project: Project = {
      projectId: randomUUID(),
      name: input.name.trim(),
      clientName: input.clientName.trim(),
      phase: 'pre_production',
      subPhase: 'discovery',
      createdAt: now.toISOString().split('T')[0],
      updatedAt: 'just now',
    };

    this.projects.push(project);
    this.persist();
    ensureProjectDirs(project.projectId);
    this.broadcast();
    recordActivity({
      ...(context?.actor ?? systemActor('Project Store')),
      occurred_at: now.toISOString(),
      event_type: 'project.created',
      lifecycle_phase: 'created',
      source_kind: context?.source_kind ?? 'background_service',
      visibility: 'user_timeline',
      title: `Project created: ${project.name}`,
      summary: `${project.clientName || 'Unassigned client'} project ${project.name} was created`,
      client_id: project.clientName || null,
      project_id: project.projectId,
      details_json: {
        name: project.name,
        clientName: project.clientName,
      },
      search_text: `${project.name} ${project.clientName}`.trim(),
    });

    console.log(`[projects] created: ${project.clientName} — ${project.name} (${project.projectId})`);
    return project;
  }

  update(projectId: string, patch: Partial<Pick<Project, 'name' | 'clientName' | 'updatedAt' | 'archived' | 'phase' | 'subPhase'>>, context?: ActivityContext): Project | null {
    const idx = this.projects.findIndex((p) => p.projectId === projectId);
    if (idx === -1) return null;

    const previous = this.projects[idx];
    this.projects[idx] = {
      ...previous,
      ...patch,
      updatedAt: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    };

    this.persist();
    this.broadcast();
    const updated = this.projects[idx];
    const archivedNow = previous.archived !== true && updated.archived === true;
    recordActivity({
      ...(context?.actor ?? systemActor('Project Store')),
      occurred_at: new Date().toISOString(),
      event_type: archivedNow ? 'project.archived' : 'project.updated',
      lifecycle_phase: 'updated',
      source_kind: context?.source_kind ?? 'background_service',
      visibility: 'user_timeline',
      title: archivedNow ? `Project archived: ${updated.name}` : `Project updated: ${updated.name}`,
      summary: archivedNow ? `${updated.name} was archived` : `${updated.name} project details were updated`,
      client_id: updated.clientName || null,
      project_id: updated.projectId,
      details_json: {
        previous,
        updated,
      },
      search_text: `${updated.name} ${updated.clientName}`.trim(),
    });
    return updated;
  }

  delete(projectId: string, context?: ActivityContext): boolean {
    const idx = this.projects.findIndex((p) => p.projectId === projectId);
    if (idx === -1) return false;

    const project = this.projects[idx];
    this.projects.splice(idx, 1);
    this.persist();
    this.broadcast();
    recordActivity({
      ...(context?.actor ?? systemActor('Project Store')),
      occurred_at: new Date().toISOString(),
      event_type: 'project.deleted',
      lifecycle_phase: 'superseded',
      source_kind: context?.source_kind ?? 'background_service',
      visibility: 'operator_only',
      title: `Project deleted: ${project.name}`,
      summary: `${project.name} was removed from LPOS`,
      client_id: project.clientName || null,
      project_id: project.projectId,
      details_json: {
        project,
      },
      search_text: `${project.name} ${project.clientName}`.trim(),
    });

    console.log(`[projects] deleted: ${projectId}`);
    return true;
  }
}
