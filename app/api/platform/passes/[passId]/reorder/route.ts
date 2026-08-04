import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { reorderCategories } from '@/lib/store/platform-pass-store';

export async function POST(req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { passId } = await params;
  const body = (await req.json().catch(() => ({}))) as { categoryIds?: string[] };
  if (!Array.isArray(body.categoryIds)) return NextResponse.json({ error: 'categoryIds required' }, { status: 400 });
  reorderCategories(passId, body.categoryIds);
  return NextResponse.json({ ok: true });
}
