import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { reorderTiles } from '@/lib/store/platform-pass-store';

/** Persist the full tile ordering for this category. Also moves tiles INTO
 *  this category when their ids appear here (drag across categories). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ categoryId: string }> }) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { categoryId } = await params;
  const body = (await req.json().catch(() => ({}))) as { tileIds?: string[] };
  if (!Array.isArray(body.tileIds)) return NextResponse.json({ error: 'tileIds required' }, { status: 400 });
  reorderTiles(categoryId, body.tileIds);
  return NextResponse.json({ ok: true });
}
