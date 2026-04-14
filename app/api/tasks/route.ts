import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore } from '@/lib/services/container';
import type { TaskPriority } from '@/lib/models/task';
import type { TaskPhase } from '@/lib/models/task-phase';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getAllUsers, getUserById } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';

export async function GET() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const tasks = getTaskStore().getForUser(session.userId);
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    description?: string;
    projectId?: string;
    clientName?: string | null;
    phase?: TaskPhase;
    priority?: TaskPriority;
    status?: string;
    notes?: string | null;
    assignedTo?: string[];
  };

  if (!body.description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }
  if (!body.phase) {
    return NextResponse.json({ error: 'phase is required' }, { status: 400 });
  }

  const task = getTaskStore().create({
    description: body.description,
    projectId: body.projectId?.trim() || 'general',
    clientName: body.clientName ?? null,
    phase: body.phase,
    priority: body.priority,
    status: body.status,
    notes: body.notes ?? null,
    createdBy: session.userId,
    assignedTo: body.assignedTo,
  });

  const actor = getUserById(session.userId);
  const actorName = actor?.name ?? undefined;
  const projectId = task.projectId !== 'unassigned' && task.projectId !== 'general' ? task.projectId : null;

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
    project_id: projectId,
    client_id: task.clientName,
  });

  // Notify assignees (not the creator) and @mentioned users in notes
  const allUsers = getAllUsers();
  const notified = new Set<string>([session.userId]);

  const mentionedIds: string[] = [];
  if (task.notes) {
    for (const [, token] of task.notes.matchAll(/@(\w+)/g)) {
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
