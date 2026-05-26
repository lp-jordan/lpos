import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getProjectNoteStore } from '@/lib/services/container';

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * GET /api/ep/projects/:projectId/notes
 *
 * Returns production notes for a project.
 * EditPanel uses these to place timeline markers in DaVinci Resolve.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId } = await params;
  const notes = getProjectNoteStore().getForProject(projectId);
  return NextResponse.json({ notes });
}
