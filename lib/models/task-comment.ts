export interface TaskCommentAttachment {
  key:  string;
  name: string;
  mime: string;
  size: number;
}

export interface TaskComment {
  commentId:   string;
  taskId:      string;
  body:        string;
  authorId:    string;
  mentions:    string[];  // userId[] resolved from @firstName tokens
  createdAt:   string;
  editedAt?:   string;
  attachments: TaskCommentAttachment[];
}
