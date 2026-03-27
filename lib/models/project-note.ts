export interface ProjectNote {
  noteId: string;
  projectId: string;
  clientName: string;       // denormalized for display
  body: string;             // plain text; @Name mentions parsed on save
  taggedUsers: string[];    // userId[] resolved from @mentions
  createdBy: string;        // userId
  createdAt: string;        // ISO string
  resolved: boolean;
  resolvedAt?: string;      // ISO string
  resolvedBy?: string;      // userId
}
