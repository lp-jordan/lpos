import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { buildCatchup, defaultCatchupDate, isValidCatchupDate } from '@/lib/services/catchup-service';

// Org-wide Daily Catch-Up. Returns the full deterministic recap for a past day
// (defaults to yesterday, server-local/Eastern) plus a cached AI headline.
// Same content for every signed-in user; visibility is enforced inside the
// builder ('user_timeline' events only).
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam && isValidCatchupDate(dateParam) ? dateParam : defaultCatchupDate();
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';

  try {
    const payload = await buildCatchup(date, { refresh });
    return NextResponse.json(payload);
  } catch (err) {
    console.error('[catchup] failed to build payload:', err);
    return NextResponse.json({ error: 'Failed to build catch-up' }, { status: 500 });
  }
}
