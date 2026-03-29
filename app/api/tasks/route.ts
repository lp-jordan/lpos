import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore } from '@/lib/services/container';
import type { TaskPriority } from '@/lib/models/task';
import { recordActivity } from '@/lib/services/activity-monitor-service';
import { getAllUsers, getUserById } from '@/lib/store/user-store';
import { getActivityDb } from '@/lib/store/activity-db';

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
    priority?: TaskPriority;
    notes?: string | null;
    assignedTo?: string[];
  };

  if (!body.description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }
  if (!body.projectId?.trim()) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  const task = getTaskStore().create({
    description: body.description,
    projectId: body.projectId,
    clientName: body.clientName ?? null,
    priority: body.priority,
    notes: body.notes ?? null,
    createdBy: session.userId,
    assignedTo: body.assignedTo,
  });

  const actor = getUserById(session.userId);
  const actorDisplay = actor?.name ?? null;
  const projectId = task.projectId !== 'unassigned' ? task.projectId : null;

  const recorded = recordActivity({
    actor_type: 'user',
    actor_id: session.userId,
    actor_display: actorDisplay,
    occurred_at: task.createdAt,
    event_type: 'task.created',
    lifecycle_phase: 'created',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: `Task created: ${task.description}`,
    project_id: projectId,
    client_id: task.clientName,
  });

  // Write mention notifications for any @names in notes.
  if (task.notes && recorded) {
    const allUsers = getAllUsers();
    const db = getActivityDb();
    const now = new Date().toISOString();
    const seen = new Set<string>();
    for (const [, token] of task.notes.matchAll(/@(\w+)/g)) {
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
        randomUUID(), projectId, task.clientName, recorded.event.event_id,
        'task_mention', 'info',
        `${actorDisplay ?? 'Someone'} mentioned you in a task`,
        task.description,
        JSON.stringify({ userId: mentioned.id, taskId: task.taskId }),
        `task-mention:${task.taskId}:${mentioned.id}`,
        now, now,
      );
    }
  }

  return NextResponse.json({ task }, { status: 201 });
}
