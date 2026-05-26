import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';

/** GET /api/ep/health — lightweight liveness + auth check for EditPanel. */
export async function GET(req: NextRequest) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    service: 'lpos-dashboard',
    user: { id: auth.user.id, name: auth.user.name, email: auth.user.email, role: auth.role },
  });
}
