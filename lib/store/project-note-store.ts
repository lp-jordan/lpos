import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectNote } from '@/lib/models/project-note';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const NOTES_FILE = path.join(DATA_DIR, 'project-notes.json');

interface NotesFile {
  notes: ProjectNote[];
}

export class ProjectNoteStore {
  private notes: ProjectNote[] = [];

  constructor() {
    this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(NOTES_FILE)) {
        const data = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')) as NotesFile;
        this.notes = data.notes ?? [];
      }
    } catch {
      this.notes = [];
    }
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NOTES_FILE, JSON.stringify({ notes: this.notes }, null, 2));
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  getForProject(projectId: string): ProjectNote[] {
    return this.notes
      .filter((n) => n.projectId === projectId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /** Returns unresolved notes that tag this user. */
  getUnresolvedForUser(userId: string): ProjectNote[] {
    return this.notes.filter((n) => !n.resolved && n.taggedUsers.includes(userId));
  }

  getById(noteId: string): ProjectNote | null {
    return this.notes.find((n) => n.noteId === noteId) ?? null;
  }

  // ── Write ────────────────────────────────────────────────────────────────

  create(input: {
    projectId: string;
    clientName: string;
    body: string;
    taggedUsers: string[];
    createdBy: string;
  }): ProjectNote {
    const note: ProjectNote = {
      noteId: randomUUID(),
      projectId: input.projectId,
      clientName: input.clientName,
      body: input.body.trim(),
      taggedUsers: input.taggedUsers,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    this.notes.push(note);
    this.persist();
    return note;
  }

  resolve(noteId: string, resolvedBy: string): ProjectNote | null {
    const idx = this.notes.findIndex((n) => n.noteId === noteId);
    if (idx === -1) return null;
    this.notes[idx] = {
      ...this.notes[idx],
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
    };
    this.persist();
    return this.notes[idx];
  }
}
