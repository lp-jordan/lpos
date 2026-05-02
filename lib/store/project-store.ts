import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { Server as SocketIOServer } from 'socket.io';
import type { ActivityActor } from '@/lib/models/activity';
import type { Project } from '@/lib/models/project';
import { recordActivity, systemActor } from '@/lib/services/activity-monitor-service';
import { getCoreDb } from './core-db';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

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

interface ProjectRow {
  project_id:           string;
  name:                 string;
  client_name:          string;
  phase:                string;
  sub_phase:            string;
  created_at:           string;
  updated_at:           string;
  archived:             number;
  asset_link_group_id?: string | null;
  lock_reason?:         string | null;
  cloudflare_defaults?: string | null;
}

function rowToProject(row: ProjectRow): Project {
  let cloudflareDefaults: Project['cloudflareDefaults'];
  if (row.cloudflare_defaults) {
    try {
      cloudflareDefaults = JSON.parse(row.cloudflare_defaults) as Project['cloudflareDefaults'];
    } catch {
      cloudflareDefaults = undefined;
    }
  }

  return {
    projectId:          row.project_id,
    name:               row.name,
    clientName:         row.client_name,
    phase:              row.phase as Project['phase'],
    subPhase:           row.sub_phase as Project['subPhase'],
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
    archived:           row.archived === 1 ? true : undefined,
    assetLinkGroupId:   row.asset_link_group_id ?? undefined,
    assetMergeLocked:   row.lock_reason ? true : undefined,
    cloudflareDefaults,
  };
}

export class ProjectStore {
  private io: SocketIOServer | undefined;

  constructor(io?: SocketIOServer) {
    this.io = io;
    ensureDir(DATA_DIR);
  }

  attachIo(io: SocketIOServer) {
    this.io = io;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private broadcast() {
    this.io?.emit('projects:changed', this.getAll());
  }

  /** Call this from outside the store (e.g. merge-worker) after lock changes. */
  broadcastAll() {
    this.broadcast();
  }

  // ── Read ───────────────────────────────────────────────────────────────

  getAll(): Project[] {
    return (getCoreDb().prepare(`
      SELECT p.*, l.reason AS lock_reason
      FROM projects p
      LEFT JOIN asset_link_locks l ON l.project_id = p.project_id
      ORDER BY p.created_at DESC
    `).all() as ProjectRow[]).map(rowToProject);
  }

  getById(projectId: string): Project | null {
    const row = getCoreDb().prepare(`
      SELECT p.*, l.reason AS lock_reason
      FROM projects p
      LEFT JOIN asset_link_locks l ON l.project_id = p.project_id
      WHERE p.project_id = ?
    `).get(projectId) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
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

    getCoreDb().prepare(
      `INSERT INTO projects (project_id, name, client_name, phase, sub_phase, created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(project.projectId, project.name, project.clientName, project.phase, project.subPhase, project.createdAt, project.updatedAt);

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
      details_json: { name: project.name, clientName: project.clientName },
      search_text: `${project.name} ${project.clientName}`.trim(),
    });

    console.log(`[projects] created: ${project.clientName} — ${project.name} (${project.projectId})`);
    return project;
  }

  update(
    projectId: string,
    patch: Partial<Pick<Project, 'name' | 'clientName' | 'updatedAt' | 'archived' | 'phase' | 'subPhase' | 'cloudflareDefaults'>>,
    context?: ActivityContext,
  ): Project | null {
    const db = getCoreDb();
    const previous = this.getById(projectId);
    if (!previous) return null;

    const next: Project = {
      ...previous,
      ...patch,
      updatedAt: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    };

    const cloudflareDefaultsJson = next.cloudflareDefaults
      ? JSON.stringify(next.cloudflareDefaults)
      : null;

    db.prepare(
      `UPDATE projects SET name = ?, client_name = ?, phase = ?, sub_phase = ?, updated_at = ?, archived = ?, cloudflare_defaults = ?
       WHERE project_id = ?`,
    ).run(next.name, next.clientName, next.phase, next.subPhase, next.updatedAt, next.archived === true ? 1 : 0, cloudflareDefaultsJson, projectId);

    this.broadcast();
    const archivedNow = previous.archived !== true && next.archived === true;
    recordActivity({
      ...(context?.actor ?? systemActor('Project Store')),
      occurred_at: new Date().toISOString(),
      event_type: archivedNow ? 'project.archived' : 'project.updated',
      lifecycle_phase: 'updated',
      source_kind: context?.source_kind ?? 'background_service',
      visibility: 'user_timeline',
      title: archivedNow ? `Project archived: ${next.name}` : `Project updated: ${next.name}`,
      summary: archivedNow ? `${next.name} was archived` : `${next.name} project details were updated`,
      client_id: next.clientName || null,
      project_id: next.projectId,
      details_json: { previous, updated: next },
      search_text: `${next.name} ${next.clientName}`.trim(),
    });
    return next;
  }

  delete(projectId: string, context?: ActivityContext): boolean {
    const project = this.getById(projectId);
    if (!project) return false;

    getCoreDb().prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
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
      details_json: { project },
      search_text: `${project.name} ${project.clientName}`.trim(),
    });

    console.log(`[projects] deleted: ${projectId}`);
    return true;
  }
}
