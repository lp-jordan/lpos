import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { createTile } from '@/lib/store/platform-pass-store';

export async function POST(req: NextRequest, { params }: { params: Promise<{ categoryId: string }> }) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { categoryId } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string; description?: string };
  const tile = createTile(categoryId, { title: body.title ?? 'New tile', description: body.description });
  if (!tile) return NextResponse.json({ error: 'Category not found' }, { status: 404 });
  return NextResponse.json({ tile }, { status: 201 });
}
