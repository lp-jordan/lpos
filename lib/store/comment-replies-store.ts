/**
 * Tracks Frame.io comments that LPOS posted as fake top-level comments to
 * simulate replies (Frame.io V4 has no reply-creation endpoint).
 *
 * Maps replyCommentId → parentCommentId so the GET handler can reconstruct
 * the thread structure when rendering comments in LPOS.
 *
 * Stored at: data/projects/{projectId}/comment-replies.json
 * Shape: { [replyCommentId: string]: parentCommentId: string }
 */

import path from 'node:path';
import fs   from 'node:fs';

type Store = Record<string, string>; // replyCommentId → parentCommentId

function storePath(projectId: string): string {
  return path.join(process.cwd(), 'data', 'projects', projectId, 'comment-replies.json');
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

export function setReplyParent(projectId: string, replyId: string, parentId: string): void {
  const data = read(projectId);
  data[replyId] = parentId;
  write(projectId, data);
}

export function getAllReplyParents(projectId: string): Store {
  return read(projectId);
}

export function removeReplyParent(projectId: string, replyId: string): void {
  const data = read(projectId);
  if (!data[replyId]) return;
  delete data[replyId];
  write(projectId, data);
}
