import { NextRequest, NextResponse } from 'next/server';
import { requireEpSecret } from '@/lib/services/ep-auth';

/** GET /api/ep/health — lightweight liveness + auth check for EditPanel. */
export async function GET(req: NextRequest) {
  const authError = requireEpSecret(req);
  if (authError) return authError;

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    service: 'lpos-dashboard',
  });
}
