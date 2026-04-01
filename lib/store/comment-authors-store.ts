/**
 * Persists the mapping of Frame.io comment ID → LPOS author info.
 *
 * Frame.io comments posted via LPOS are attributed to the service account
 * token, so the author returned by the Frame.io API isn't meaningful.
 * This store records who actually posted each comment so the correct name
 * (and ownership for edit/delete gating) survives server restarts.
 *
 * Stored at: data/projects/{projectId}/comment-authors.json
 * Shape: { [commentId: string]: { name: string; userId: string } }
 */

import path from 'node:path';
import fs   from 'node:fs';

export interface CommentAuthor {
  name:   string;
  userId: string;
}

type Store = Record<string, CommentAuthor>;

function storePath(projectId: string): string {
  return path.join(process.cwd(), 'data', 'projects', projectId, 'comment-authors.json');
}

function read(projectId: string): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath(projectId), 'utf-8')) as Store;
  } catch {
    return {};
  }
}

function write(projectId: string, data: Store): void {
  const p = storePath(projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

export function getCommentAuthor(projectId: string, commentId: string): CommentAuthor | undefined {
  return read(projectId)[commentId];
}

export function setCommentAuthor(projectId: string, commentId: string, author: CommentAuthor): void {
  const data = read(projectId);
  data[commentId] = author;
  write(projectId, data);
}

export function removeCommentAuthor(projectId: string, commentId: string): void {
  const data = read(projectId);
  if (!data[commentId]) return;
  delete data[commentId];
  write(projectId, data);
}
