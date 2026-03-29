import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getWishStore } from '@/lib/services/container';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ wishId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { wishId } = await params;
  const body = await req.json() as { completed?: boolean };

  const wish = getWishStore().update(wishId, { completed: body.completed });
  if (!wish) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ wish });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ wishId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { wishId } = await params;
  const deleted = getWishStore().delete(wishId);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
