import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProjectNoteStore, getProjectStore } from '@/lib/services/container';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await params;
  const notes = getProjectNoteStore().getForProject(projectId);
  return NextResponse.json({ notes });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await params;
  const project = getProjectStore().getById(projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const body = await req.json() as {
    body?: string;
    taggedUsers?: string[];
  };

  if (!body.body?.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  const note = getProjectNoteStore().create({
    projectId,
    clientName: project.clientName,
    body: body.body,
    taggedUsers: body.taggedUsers ?? [],
    createdBy: session.userId,
  });

  return NextResponse.json({ note }, { status: 201 });
}
