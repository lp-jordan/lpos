import { NextRequest, NextResponse } from 'next/server';
import { requireEpSecret } from '@/lib/services/ep-auth';
import { getProjectStore } from '@/lib/services/container';

/** GET /api/ep/projects — list all projects for EditPanel export destination picker. */
export async function GET(req: NextRequest) {
  const authError = requireEpSecret(req);
  if (authError) return authError;

  try {
    const projects = getProjectStore().getAll();
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}
