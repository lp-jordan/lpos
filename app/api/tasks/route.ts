import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore, getTaskCommentStore } from '@/lib/services/container';
import type { TaskPriority } from '@/lib/models/task';
import type { TaskType } from '@/lib/models/task-phase';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getAllUsers, getUserById } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { emitTaskCreated } from '@/lib/services/task-broadcasts';

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const scope = new URL(req.url).searchParams.get('scope');
  const tasks = scope === 'all'
    ? getTaskStore().getAll()
    : getTaskStore().getForUser(session.userId);
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    description?: string;
    clientName?: string;
    taskType?: TaskType;
    /** Platform tasks only — ignored on Editing tasks. Free text, surfaced as a
     *  group header in the Platform list view. */
    category?: string | null;
    priority?: TaskPriority;
    status?: string;
    assignedTo?: string[];
    /** Optional initial Update text. Captured from the New Task modal's "Notes" field
     *  and routed to the first task_comments row — keeps the user's intent intact even
     *  though the dedicated `notes` column has been removed in F1. */
    notes?: string | null;
  };

  if (!body.description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }
  if (!body.taskType || (body.taskType !== 'editing' && body.taskType !== 'platform')) {
    return NextResponse.json({ error: 'taskType is required and must be editing or platform' }, { status: 400 });
  }

  const task = getTaskStore().create({
    description: body.description,
    clientName: body.clientName?.trim() || 'General',
    taskType: body.taskType,
    category: body.category ?? null,
    priority: body.priority,
    status: body.status,
    createdBy: session.userId,
    assignedTo: body.assignedTo,
  });

  // Route inbound `notes` into the Updates stream as the inaugural comment.
  // Best-effort: comment-store hiccup must not roll back the task creation.
  const initialNote = body.notes?.trim();
  if (initialNote) {
    try {
      getTaskCommentStore().create({
        taskId: task.taskId,
        body: initialNote,
        authorId: session.userId,
        mentions: [],
      });
    } catch (err) {
      console.warn(`[task-create] failed to create initial-update comment for task ${task.taskId}:`, err);
    }
  }

  emitTaskCreated(task);

  const actor = getUserById(session.userId);
  const actorName = actor?.name ?? undefined;
  // No project_id linkage anymore — record activity at the client level only.
  const clientId = task.clientName !== 'General' ? task.clientName : null;

  recordActivity({
    actor_type: 'user',
    actor_id: session.userId,
    actor_display: actorName ?? null,
    occurred_at: task.createdAt,
    event_type: 'task.created',
    lifecycle_phase: 'created',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: `Task created: ${task.description}`,
    project_id: null,
    client_id: clientId,
  });

  // Notify assignees (not the creator) and @mentioned users in the initial note
  const allUsers = getAllUsers();
  const notified = new Set<string>([session.userId]);

  const mentionedIds: string[] = [];
  if (initialNote) {
    for (const [, token] of initialNote.matchAll(/@(\w+)/g)) {
      const u = allUsers.find((u) => u.name.split(' ')[0].toLowerCase() === token.toLowerCase());
      if (u && !notified.has(u.id)) {
        mentionedIds.push(u.id);
        notified.add(u.id);
      }
    }
  }

  await Promise.allSettled([
    ...task.assignedTo
      .filter((uid) => !notified.has(uid))
      .map((uid) => {
        notified.add(uid);
        return notifyTaskEvent({ userId: uid, type: 'assigned', taskId: task.taskId, taskTitle: task.description, fromUserId: session.userId, fromName: actorName });
      }),
    ...mentionedIds.map((uid) =>
      notifyTaskEvent({ userId: uid, type: 'mentioned', taskId: task.taskId, taskTitle: task.description, fromUserId: session.userId, fromName: actorName }),
    ),
  ]);

  return NextResponse.json({ task }, { status: 201 });
}
