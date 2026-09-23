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
  /** Calendar: first day the task is planned for, inclusive ISO day (YYYY-MM-DD).
   *  Null means it isn't on the calendar. NOT a due date — nothing treats a past
   *  date as late. Editing tasks in practice, though the column is type-agnostic. */
  scheduledStart: string | null;
  /** Calendar: last day, inclusive. Always non-null when scheduledStart is set,
   *  and never earlier than it (the store normalises both invariants). */
  scheduledEnd: string | null;
  /** Manual stack position among the bars sharing a week on the calendar. */
  scheduleOrder: number;
}
