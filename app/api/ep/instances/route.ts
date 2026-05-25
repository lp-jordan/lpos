import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getAllInstances } from '@/lib/store/ep-instances';

/**
 * GET /api/ep/instances
 *
 * Returns all known EditPanel instances with their online status.
 * Used by the LPOS Studio > Machines tab.
 * Protected by standard user session auth (browser, not machine secret).
 */
export async function GET(req: NextRequest) {
  const authError = await requireRole(req, 'user');
  if (authError) return authError;

  return NextResponse.json({ instances: getAllInstances() });
}
