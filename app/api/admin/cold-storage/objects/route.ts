import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { deleteOne, deletePrefix } from '@/lib/services/b2-cold-storage-browser';

/**
 * DELETE /api/admin/cold-storage/objects?key=<key>
 *   — remove a single object
 * DELETE /api/admin/cold-storage/objects?prefix=<prefix>
 *   — remove every object under the prefix (folder delete; refuses empty)
 *
 * In both cases, the tracking row is stamped with deleted_at. If the source
 * file still exists, the next sync re-uploads — so manual delete is "remove
 * now but allow re-sync." For permanent removal, delete from source first.
 */
export async function DELETE(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const url    = new URL(req.url);
  const key    = url.searchParams.get('key');
  const prefix = url.searchParams.get('prefix');

  try {
    if (key) {
      await deleteOne(key);
      return NextResponse.json({ deleted: 1, key });
    }
    if (prefix) {
      const count = await deletePrefix(prefix);
      return NextResponse.json({ deleted: count, prefix });
    }
    return NextResponse.json({ error: 'key or prefix required' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
