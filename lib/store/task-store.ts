import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, TaskPriority, TaskStatus } from '@/lib/models/task';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

interface TasksFile {
  tasks: Task[];
}

/** Shape of a task as it may exist on disk before the schema upgrade. */
interface LegacyTask extends Omit<Task, 'projectId' | 'priority' | 'status' | 'notes'> {
  projectId?: string | null;
  priority?: TaskPriority;
  status?: string; // broader string to handle old 'todo' value
  notes?: string | null;
  completed?: boolean;
}

function migrate(raw: LegacyTask): Task {
  const rawStatus = raw.status === 'todo' ? 'not_started' : raw.status;
  const status: TaskStatus = (rawStatus as TaskStatus) ?? (raw.completed ? 'done' : 'not_started');
  return {
    taskId: raw.taskId,
    description: raw.description,
    projectId: raw.projectId ?? 'unassigned',
    clientName: raw.clientName ?? null,
    priority: raw.priority ?? 'medium',
    status,
    notes: raw.notes ?? null,
    createdBy: raw.createdBy,
    assignedTo: raw.assignedTo,
    createdAt: raw.createdAt,
    completedAt: status === 'done' ? (raw.completedAt ?? raw.createdAt) : undefined,
  };
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
        const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) as { tasks: LegacyTask[] };
        this.tasks = (data.tasks ?? []).map(migrate);
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
    projectId: string;
    clientName?: string | null;
    priority?: TaskPriority;
    notes?: string | null;
    createdBy: string;
    assignedTo?: string[];
  }): Task {
    const task: Task = {
      taskId: randomUUID(),
      description: input.description.trim(),
      projectId: input.projectId,
      clientName: input.clientName ?? null,
      priority: input.priority ?? 'medium',
      status: 'not_started',
      notes: input.notes ?? null,
      createdBy: input.createdBy,
      assignedTo: input.assignedTo?.length ? input.assignedTo : [input.createdBy],
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    this.persist();
    return task;
  }

  update(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'description' | 'assignedTo' | 'priority' | 'notes'>>,
  ): Task | null {
    const idx = this.tasks.findIndex((t) => t.taskId === taskId);
    if (idx === -1) return null;
    const prev = this.tasks[idx];
    const nextStatus = patch.status ?? prev.status;
    this.tasks[idx] = {
      ...prev,
      ...patch,
      completedAt:
        nextStatus === 'done' && prev.status !== 'done'
          ? new Date().toISOString()
          : nextStatus !== 'done'
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
