import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { listPasses, createPass } from '@/lib/store/platform-pass-store';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ passes: listPasses() });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { title?: string; brand?: string };
  if (!body.title?.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 });

  const pass = createPass({ title: body.title, brand: body.brand, createdBy: session.userId });
  return NextResponse.json({ pass }, { status: 201 });
}
