export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'waiting_on_client' | 'done';

export interface Task {
  taskId: string;
  description: string;
  projectId: string;           // required
  clientName: string | null;   // denormalised for display
  priority: TaskPriority;
  status: TaskStatus;          // 'done' replaces the old completed boolean
  notes: string | null;
  createdBy: string;           // userId
  assignedTo: string[];        // userId[]
  createdAt: string;           // ISO string
  completedAt?: string;        // ISO string — set when status transitions to 'done'
}
