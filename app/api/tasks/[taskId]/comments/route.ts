import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore, getTaskCommentStore } from '@/lib/services/container';
import { getAllUsers } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';

type Params = { params: Promise<{ taskId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  const comments = getTaskCommentStore().getForTask(taskId);
  return NextResponse.json({ comments });
}

export async function POST(req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;

  const task = getTaskStore().getById(taskId);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const body = await req.json() as { body?: string };
  if (!body.body?.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 });
  }

  // Resolve @firstName mentions to userIds
  const allUsers = getAllUsers();
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const [, token] of body.body.matchAll(/@(\w+)/g)) {
    const matched = allUsers.find(
      (u) => u.name.split(' ')[0].toLowerCase() === token.toLowerCase(),
    );
    if (matched && !seen.has(matched.id)) {
      mentions.push(matched.id);
      seen.add(matched.id);
    }
  }

  const comment = getTaskCommentStore().create({
    taskId,
    body: body.body,
    authorId: session.userId,
    mentions,
  });

  // Notify: assignees (except commenter) + @mentioned users
  const actorName = allUsers.find((u) => u.id === session.userId)?.name;
  const recipientIds = new Set<string>([...task.assignedTo, ...mentions]);
  recipientIds.delete(session.userId);

  await Promise.allSettled(
    [...recipientIds].map((uid) =>
      notifyTaskEvent({
        userId: uid,
        type: mentions.includes(uid) ? 'mentioned' : 'commented',
        taskId,
        taskTitle: task.description,
        fromUserId: session.userId,
        fromName: actorName,
      }),
    ),
  );

  return NextResponse.json({ comment }, { status: 201 });
}
