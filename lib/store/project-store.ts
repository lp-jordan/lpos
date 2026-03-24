import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import type { Project } from '@/lib/models/project';

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
      this.projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')) as Project[];
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

  create(input: CreateProjectInput): Project {
    const now = new Date();
    const project: Project = {
      projectId: randomUUID(),
      name: input.name.trim(),
      clientName: input.clientName.trim(),
      createdAt: now.toISOString().split('T')[0],
      updatedAt: 'just now',
    };

    this.projects.push(project);
    this.persist();
    ensureProjectDirs(project.projectId);
    this.broadcast();

    console.log(`[projects] created: ${project.clientName} — ${project.name} (${project.projectId})`);
    return project;
  }

  update(projectId: string, patch: Partial<Pick<Project, 'name' | 'clientName' | 'updatedAt' | 'archived'>>): Project | null {
    const idx = this.projects.findIndex((p) => p.projectId === projectId);
    if (idx === -1) return null;

    this.projects[idx] = {
      ...this.projects[idx],
      ...patch,
      updatedAt: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    };

    this.persist();
    this.broadcast();
    return this.projects[idx];
  }

  delete(projectId: string): boolean {
    const idx = this.projects.findIndex((p) => p.projectId === projectId);
    if (idx === -1) return false;

    this.projects.splice(idx, 1);
    this.persist();
    this.broadcast();

    console.log(`[projects] deleted: ${projectId}`);
    return true;
  }
}
