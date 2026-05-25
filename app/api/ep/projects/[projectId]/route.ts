import { NextRequest, NextResponse } from 'next/server';
import { requireEpSecret } from '@/lib/services/ep-auth';
import { getProjectStore } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string }> };

/** GET /api/ep/projects/:projectId — single project detail for EditPanel. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const authError = requireEpSecret(req);
  if (authError) return authError;

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  return NextResponse.json({ project });
}
