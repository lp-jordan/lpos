import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore } from '@/lib/services/container';
import type { TaskPriority, TaskStatus } from '@/lib/models/task';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getAllUsers, getUserById } from '@/lib/store/user-store';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  const body = await req.json() as {
    status?: TaskStatus;
    description?: string;
    assignedTo?: string[];
    priority?: TaskPriority;
    notes?: string | null;
  };

  const prev = getTaskStore().getById(taskId);
  const updated = getTaskStore().update(taskId, body);
  if (!updated) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const actor = getUserById(session.userId);
  const actorName = actor?.name ?? undefined;
  const projectId = updated.projectId !== 'unassigned' ? updated.projectId : null;
  const now = new Date().toISOString();

  const statusChanged = body.status !== undefined && prev !== null && body.status !== prev.status;
  const assigneesChanged = body.assignedTo !== undefined;

  recordActivity({
    actor_type: 'user',
    actor_id: session.userId,
    actor_display: actorName ?? null,
    occurred_at: now,
    event_type: statusChanged ? 'task.status.changed' : 'task.updated',
    lifecycle_phase: 'updated',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: statusChanged
      ? `Task marked ${body.status?.replace(/_/g, ' ')}: ${updated.description}`
      : `Task updated: ${updated.description}`,
    project_id: projectId,
    client_id: updated.clientName,
  });

  const allUsers = getAllUsers();
  const notified = new Set<string>([session.userId]);

  // Notify on status change
  if (statusChanged) {
    await Promise.allSettled(
      updated.assignedTo
        .filter((uid) => !notified.has(uid))
        .map((uid) => {
          notified.add(uid);
          return notifyTaskEvent({ userId: uid, type: 'status_changed', taskId, taskTitle: updated.description, fromUserId: session.userId, fromName: actorName });
        }),
    );
  }

  // Notify newly added assignees
  if (assigneesChanged && prev) {
    const prevIds = new Set(prev.assignedTo);
    await Promise.allSettled(
      (body.assignedTo ?? [])
        .filter((uid) => !prevIds.has(uid) && !notified.has(uid))
        .map((uid) => {
          notified.add(uid);
          return notifyTaskEvent({ userId: uid, type: 'assigned', taskId, taskTitle: updated.description, fromUserId: session.userId, fromName: actorName });
        }),
    );
  }

  // Notify @mentioned users in notes if notes changed
  if (body.notes !== undefined && body.notes && updated.notes) {
    for (const [, token] of updated.notes.matchAll(/@(\w+)/g)) {
      const u = allUsers.find((u) => u.name.split(' ')[0].toLowerCase() === token.toLowerCase());
      if (u && !notified.has(u.id)) {
        notified.add(u.id);
        await notifyTaskEvent({ userId: u.id, type: 'mentioned', taskId, taskTitle: updated.description, fromUserId: session.userId, fromName: actorName });
      }
    }
  }

  return NextResponse.json({ task: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  const ok = getTaskStore().delete(taskId);
  if (!ok) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
