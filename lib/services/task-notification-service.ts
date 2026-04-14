/**
 * Task Notification Service
 *
 * Called from API routes whenever a notifiable task event occurs.
 * Persists to task_notifications, emits via Socket.io to the user's room,
 * and optionally sends a browser push notification.
 */

import webpush from 'web-push';
import type { TaskNotifType } from '@/lib/models/task-notification';
import { getTaskNotificationStore, getIo } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';
import { getUserById } from '@/lib/store/user-store';
import { sendSlackTaskDm } from '@/lib/services/slack-service';

// ── VAPID init (best-effort — skipped if keys not configured) ─────────────

let vapidReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      `mailto:${process.env.VAPID_CONTACT_EMAIL ?? 'lpos@localhost'}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    vapidReady = true;
  } catch {
    console.warn('[task-notif] VAPID init failed — browser push disabled');
  }
}

// ── Push subscription lookup ──────────────────────────────────────────────

interface PushSubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function getPushSubs(userId: string): PushSubRow[] {
  try {
    return getCoreDb()
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as PushSubRow[];
  } catch {
    return [];
  }
}

// ── Main export ───────────────────────────────────────────────────────────

export async function notifyTaskEvent(input: {
  userId: string;
  type: TaskNotifType;
  taskId: string;
  taskTitle: string;
  fromUserId?: string;
  fromName?: string;
}): Promise<void> {
  // Don't notify yourself
  if (!input.userId) return;

  // 1. Persist
  const notif = getTaskNotificationStore().create(input);

  // 2. Real-time via Socket.io
  const io = getIo();
  if (io) {
    io.to(`user:${input.userId}`).emit('task:notification', notif);
  }

  // 3. Slack DM (best-effort)
  const recipient = getUserById(input.userId);
  if (recipient) {
    sendSlackTaskDm({
      email: recipient.slackEmail ?? recipient.email,
      type: input.type,
      taskTitle: input.taskTitle,
      fromName: input.fromName,
    }).catch((err: unknown) => {
      console.warn('[task-notif] Slack DM failed:', err);
    });
  }

  // 4. Browser push (best-effort)
  if (vapidReady) {
    const subs = getPushSubs(input.userId);
    const label: Record<TaskNotifType, string> = {
      assigned: 'You were assigned a task',
      mentioned: 'You were mentioned in a task',
      status_changed: 'A task status changed',
      commented: 'New comment on a task',
    };
    const payload = JSON.stringify({
      title: label[input.type],
      body: input.taskTitle,
      taskId: input.taskId,
    });
    await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        ).catch((err: unknown) => {
          // Remove expired subscriptions (HTTP 410 Gone)
          if ((err as { statusCode?: number }).statusCode === 410) {
            getCoreDb()
              .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
              .run(sub.endpoint);
          }
        }),
      ),
    );
  }
}
