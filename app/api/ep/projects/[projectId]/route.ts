import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getProjectStore } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string }> };

/** GET /api/ep/projects/:projectId — single project detail for EditPanel. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  return NextResponse.json({ project });
}
