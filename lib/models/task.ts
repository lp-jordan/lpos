import type { TaskPhase } from './task-phase';

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Task {
  taskId: string;
  description: string;
  projectId: string;
  clientName: string | null;
  phase: TaskPhase;
  priority: TaskPriority;
  status: string;
  notes: string | null;
  createdBy: string;
  assignedTo: string[];
  createdAt: string;
  completedAt?: string;
}
