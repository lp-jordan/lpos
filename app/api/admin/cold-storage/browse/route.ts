import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { browse } from '@/lib/services/b2-cold-storage-browser';

/**
 * GET /api/admin/cold-storage/browse?prefix=Projects/2026/
 *
 * Lists one level of the cold-storage B2 bucket using the '/' delimiter.
 * Empty prefix = root. Admin-only.
 */
export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const prefix = new URL(req.url).searchParams.get('prefix') ?? '';
  try {
    const data = await browse(prefix);
    return NextResponse.json({ prefix, ...data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
