/**
 * GET /api/cloudflare/dashboard/[uid]
 *
 * Redirects to the video's page in the Cloudflare dashboard. Built server-side
 * so the account ID stays in env (Doppler) instead of being shipped to the
 * client. Used by the media sidebar's "Open in Cloudflare" link.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { cloudflareDashboardVideoUrl } from '@/lib/services/cloudflare-stream';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ uid: string }> }) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session || session.role === 'guest') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { uid } = await params;
  if (!/^[a-f0-9]{32}$/i.test(uid)) return NextResponse.json({ error: 'Invalid video id' }, { status: 400 });

  const url = cloudflareDashboardVideoUrl(uid);
  if (!url) return NextResponse.json({ error: 'Cloudflare account is not configured' }, { status: 503 });
  return NextResponse.redirect(url);
}
