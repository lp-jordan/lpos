import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getProjectStore } from '@/lib/services/container';

/** GET /api/ep/projects — list all projects for EditPanel export destination picker. */
export async function GET(req: NextRequest) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const projects = getProjectStore().getAll();
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}
