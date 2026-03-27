import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getProjectNoteStore } from '@/lib/services/container';

/** PATCH /api/projects/[projectId]/notes/[noteId] — resolve a note */
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; noteId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { noteId } = await params;
  const resolved = getProjectNoteStore().resolve(noteId, session.userId);
  if (!resolved) return NextResponse.json({ error: 'Note not found' }, { status: 404 });

  return NextResponse.json({ note: resolved });
}
