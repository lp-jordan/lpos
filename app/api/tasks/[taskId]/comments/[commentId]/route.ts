import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskCommentStore } from '@/lib/services/container';
import { getAllUsers } from '@/lib/store/user-store';
import { deleteAttachment } from '@/lib/services/r2-attachments';

type Params = { params: Promise<{ taskId: string; commentId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { commentId } = await params;
  const payload = await req.json() as { body?: string };
  if (!payload.body?.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  // Resolve @firstName mentions to userIds (same logic as POST)
  const allUsers = getAllUsers();
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const [, token] of payload.body.matchAll(/@(\w+)/g)) {
    const matched = allUsers.find(
      (u) => u.name.split(' ')[0].toLowerCase() === token.toLowerCase(),
    );
    if (matched && !seen.has(matched.id)) {
      mentions.push(matched.id);
      seen.add(matched.id);
    }
  }

  const comment = getTaskCommentStore().update(commentId, session.userId, payload.body, mentions);
  if (!comment) return NextResponse.json({ error: 'Not found or not your comment' }, { status: 404 });

  return NextResponse.json({ comment });
}

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
