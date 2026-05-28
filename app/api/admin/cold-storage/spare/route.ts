import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { spareObject } from '@/lib/store/b2-cold-storage-store';

/**
 * POST /api/admin/cold-storage/spare?key=<key>
 *
 * Admin says "don't delete this one yet." Clears missing_since on the
 * tracking row so it leaves the awaiting-review list. If the source file
 * is still gone, the next sync's markMissing pass will stamp missing_since
 * again, restarting the retention window — i.e. "ask me again in
 * retainDays". If the file came back to source, the upsertSeen call would
 * already have cleared missing_since; this endpoint is for the case where
 * source is still empty but the operator wants to keep the backup.
 */
export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const key = new URL(req.url).searchParams.get('key');
  if (!key) {
    return NextResponse.json({ error: 'key required' }, { status: 400 });
  }

  try {
    spareObject(key);
    return NextResponse.json({ spared: key });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
