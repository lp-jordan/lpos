/**
 * Local soft-delete helper.
 *
 * Moves a local file into the project's recoverable trash dir
 * (data/projects/<id>/.trash/) instead of unlinking it. Used by local-bytes
 * adapters so a deletion mirrored from Drive never destroys local bytes
 * outright — they can be recovered from .trash (and the Drive copy itself sits
 * in Drive Trash for ~30 days).
 */

import fs   from 'node:fs';
import path from 'node:path';

const DATA_DIR = () => process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

/**
 * Move `filePath` into data/projects/<projectId>/.trash/, prefixed with a
 * timestamp to avoid collisions. Returns the new path, or null if the file
 * didn't exist or the move failed (best-effort — never throws).
 */
export function softDeleteLocalFile(projectId: string, filePath: string): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const trashDir = path.join(DATA_DIR(), 'projects', projectId, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest  = path.join(trashDir, `${stamp}__${path.basename(filePath)}`);
    fs.renameSync(filePath, dest);
    return dest;
  } catch {
    return null;
  }
}
