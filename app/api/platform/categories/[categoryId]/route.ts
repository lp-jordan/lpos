import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { updateCategory, deleteCategory } from '@/lib/store/platform-pass-store';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ categoryId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { categoryId } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string; position?: number };
  updateCategory(categoryId, body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ categoryId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { categoryId } = await params;
  deleteCategory(categoryId);
  return NextResponse.json({ ok: true });
}
