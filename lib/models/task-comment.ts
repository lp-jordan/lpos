export interface TaskComment {
  commentId: string;
  taskId: string;
  body: string;
  authorId: string;
  mentions: string[];  // userId[] resolved from @firstName tokens
  createdAt: string;
  editedAt?: string;
}
