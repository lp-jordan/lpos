import webpush from 'web-push';
import type { ProspectNotifType } from '@/lib/models/prospect-notification';
import { getProspectNotificationStore, getIo } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';

// ── VAPID init (shared config — same keys as task notifications) ──────────

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
    // VAPID already initialized by task notification service in same process
    vapidReady = true;
  }
}

// ── Push subscription lookup ──────────────────────────────────────────────

interface PushSubRow { endpoint: string; p256dh: string; auth: string; }

function getPushSubs(userId: string): PushSubRow[] {
  try {
    return getCoreDb()
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as PushSubRow[];
  } catch { return []; }
}

// ── Main export ───────────────────────────────────────────────────────────

const PUSH_LABEL: Record<ProspectNotifType, string> = {
  assigned:       'You were assigned to a prospect',
  update_posted:  'New update on a prospect',
  mentioned:      'You were mentioned in a prospect update',
  status_changed: 'Prospect status changed',
  promoted:       'Prospect promoted to client',
};

export async function notifyProspectEvent(input: {
  userId:      string;
  type:        ProspectNotifType;
  prospectId:  string;
  company:     string;
  fromUserId?: string;
  fromName?:   string;
}): Promise<void> {
  if (!input.userId) return;

  // 1. Persist
  const notif = getProspectNotificationStore().create(input);

  // 2. Real-time via Socket.io
  const io = getIo();
  if (io) {
    io.to(`user:${input.userId}`).emit('prospect:notification', notif);
  }

  // 3. Browser push (best-effort)
  if (vapidReady) {
    const subs = getPushSubs(input.userId);
    const payload = JSON.stringify({
      title: PUSH_LABEL[input.type],
      body:  input.company,
      prospectId: input.prospectId,
    });
    await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        ).catch((err: unknown) => {
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
