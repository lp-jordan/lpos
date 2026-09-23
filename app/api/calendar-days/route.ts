import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getCalendarDayStore } from '@/lib/store/calendar-day-store';
import { emitCalendarDayChanged } from '@/lib/services/task-broadcasts';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ overrides: getCalendarDayStore().getAll() });
}

/**
 * Set an override. `working` is required and runs both ways — false skips a
 * normally-working day, true opens a normally-off one. The client deletes
 * instead of posting an override that matches the default pattern.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { date?: string; working?: boolean };
  if (!body.date || typeof body.working !== 'boolean') {
    return NextResponse.json({ error: 'date and working are required' }, { status: 400 });
  }

  const saved = getCalendarDayStore().set(body.date, body.working, session.userId);
  if (!saved) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });

  emitCalendarDayChanged(saved.date, saved.working);
  return NextResponse.json({ override: saved });
}

/** Clear an override (?date=YYYY-MM-DD), returning the day to the default. */
export async function DELETE(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const date = new URL(req.url).searchParams.get('date');
  if (!date) return NextResponse.json({ error: 'date is required' }, { status: 400 });

  getCalendarDayStore().clear(date);

  emitCalendarDayChanged(date, null);
  return NextResponse.json({ ok: true });
}
