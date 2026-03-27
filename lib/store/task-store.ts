import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task } from '@/lib/models/task';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

interface TasksFile {
  tasks: Task[];
}

export class TaskStore {
  private tasks: Task[] = [];

  constructor() {
    this.load();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) as TasksFile;
        this.tasks = data.tasks ?? [];
      }
    } catch {
      this.tasks = [];
    }
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: this.tasks }, null, 2));
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  getAll(): Task[] {
    return [...this.tasks];
  }

  /** Returns tasks where the user created or is assigned. */
  getForUser(userId: string): Task[] {
    return this.tasks.filter(
      (t) => t.createdBy === userId || t.assignedTo.includes(userId),
    );
  }

  getById(taskId: string): Task | null {
    return this.tasks.find((t) => t.taskId === taskId) ?? null;
  }

  // ── Write ────────────────────────────────────────────────────────────────

  create(input: {
    description: string;
    projectId?: string | null;
    clientName?: string | null;
    createdBy: string;
    assignedTo?: string[];
  }): Task {
    const task: Task = {
      taskId: randomUUID(),
      description: input.description.trim(),
      projectId: input.projectId ?? null,
      clientName: input.clientName ?? null,
      createdBy: input.createdBy,
      assignedTo: input.assignedTo?.length ? input.assignedTo : [input.createdBy],
      completed: false,
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.persist();
    return task;
  }

  update(taskId: string, patch: Partial<Pick<Task, 'completed' | 'description' | 'assignedTo'>>): Task | null {
    const idx = this.tasks.findIndex((t) => t.taskId === taskId);
    if (idx === -1) return null;
    const prev = this.tasks[idx];
    this.tasks[idx] = {
      ...prev,
      ...patch,
      completedAt:
        patch.completed === true && !prev.completed
          ? new Date().toISOString()
          : patch.completed === false
            ? undefined
            : prev.completedAt,
    };
    this.persist();
    return this.tasks[idx];
  }

  delete(taskId: string): boolean {
    const idx = this.tasks.findIndex((t) => t.taskId === taskId);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    this.persist();
    return true;
  }
}
