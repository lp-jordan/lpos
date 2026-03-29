import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore } from '@/lib/services/container';
import type { TaskPriority, TaskStatus } from '@/lib/models/task';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getAllUsers, getUserById } from '@/lib/store/user-store';
import { getActivityDb } from '@/lib/store/activity-db';

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
  const actorDisplay = actor?.name ?? null;
  const projectId = updated.projectId !== 'unassigned' ? updated.projectId : null;
  const now = new Date().toISOString();

  const statusChanged = body.status && prev && body.status !== prev.status;
  const notesChanged = body.notes !== undefined && body.notes !== (prev?.notes ?? null);

  const recorded = recordActivity({
    actor_type: 'user',
    actor_id: session.userId,
    actor_display: actorDisplay,
    occurred_at: now,
    event_type: statusChanged ? 'task.status.changed' : 'task.updated',
    lifecycle_phase: 'updated',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: statusChanged
      ? `Task marked ${body.status?.replace('_', ' ')}: ${updated.description}`
      : `Task updated: ${updated.description}`,
    project_id: projectId,
    client_id: updated.clientName,
  });

  // Write mention notifications for newly @mentioned users in notes.
  if (notesChanged && updated.notes && recorded) {
    const allUsers = getAllUsers();
    const db = getActivityDb();
    const seen = new Set<string>();
    for (const [, token] of updated.notes.matchAll(/@(\w+)/g)) {
      const mentioned = allUsers.find(
        (u) => u.name.split(' ')[0].toLowerCase() === token.toLowerCase(),
      );
      if (!mentioned || mentioned.id === session.userId || seen.has(mentioned.id)) continue;
      seen.add(mentioned.id);
      db.prepare(`
        INSERT OR IGNORE INTO notification_candidates (
          notification_candidate_id, project_id, client_id, event_id,
          notification_type, severity, title, body, status,
          recipient_scope_json, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        randomUUID(), projectId, updated.clientName, recorded.event.event_id,
        'task_mention', 'info',
        `${actorDisplay ?? 'Someone'} mentioned you in a task`,
        updated.description,
        JSON.stringify({ userId: mentioned.id, taskId: updated.taskId }),
        `task-mention:${updated.taskId}:${mentioned.id}`,
        now, now,
      );
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
