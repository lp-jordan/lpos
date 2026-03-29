import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getWishStore } from '@/lib/services/container';
import { getUserById } from '@/lib/store/user-store';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wishes = getWishStore().getAll();
  return NextResponse.json({ wishes });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { title?: string; description?: string };

  if (!body.title?.trim()) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const user = getUserById(session.userId);
  const wish = getWishStore().create({
    title: body.title,
    description: body.description,
    submittedBy: session.userId,
    submittedByName: user?.name ?? 'Unknown',
  });

  return NextResponse.json({ wish }, { status: 201 });
}
