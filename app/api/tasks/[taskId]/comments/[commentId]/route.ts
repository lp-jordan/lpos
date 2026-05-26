import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskCommentStore } from '@/lib/services/container';
import { deleteAttachment } from '@/lib/services/r2-attachments';

type Params = { params: Promise<{ taskId: string; commentId: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { commentId } = await params;
  const store   = getTaskCommentStore();
  const comment = store.getById(commentId);

  const ok = store.delete(commentId, session.userId);
  if (!ok) return NextResponse.json({ error: 'Not found or not your comment' }, { status: 404 });

  // Clean up R2 attachments
  if (comment?.attachments.length) {
    void Promise.allSettled(comment.attachments.map((a) => deleteAttachment(a.key)));
  }

  return NextResponse.json({ ok: true });
}
