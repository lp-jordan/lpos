import type { TaskType } from './task-phase';

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Task {
  taskId: string;
  description: string;
  /** Required. "General" is the sentinel for tasks not tied to a specific client. */
  clientName: string;
  taskType: TaskType;
  /** Platform tasks only. Free-text starting from a seeded set (see task-categories.ts).
   *  Always null for Editing tasks. */
  category: string | null;
  priority: TaskPriority;
  status: string;
  createdBy: string;
  assignedTo: string[];
  createdAt: string;
  completedAt?: string;
}
