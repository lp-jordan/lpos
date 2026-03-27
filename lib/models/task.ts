export interface Task {
  taskId: string;
  description: string;
  projectId: string | null;
  clientName: string | null;
  createdBy: string;       // userId
  assignedTo: string[];    // userId[]
  completed: boolean;
  createdAt: string;       // ISO string
  completedAt?: string;    // ISO string
}
