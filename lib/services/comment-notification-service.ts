import webpush from 'web-push';
import type { CommentNotifType } from '@/lib/models/comment-notification';
import { getCommentNotificationStore, getIo } from '@/lib/services/container';
import { getCoreDb } from '@/lib/store/core-db';

// ── VAPID init (shared config — same keys as task/prospect notifications) ──

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
    // VAPID already initialized by another notification service in same process
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

const PUSH_LABEL: Record<CommentNotifType, string> = {
  reply: 'New reply to your comment',
};

/**
 * Notify the original commenter that someone replied to their comment.
 *
 * Only fires when we know the recipient's LPOS userId (i.e. the parent comment
 * was authored from within LPOS — see comment-authors-store). Replies to
 * external Frame.io reviewers have no in-app recipient and are skipped by the
 * caller. Self-replies (replier === recipient) should also be skipped upstream.
 */
export async function notifyCommentReply(input: {
  userId:      string;
  projectId:   string;
  assetId:     string;
  assetName:   string;
  commentId:   string;
  fromUserId?: string;
  fromName?:   string;
  snippet?:    string;
}): Promise<void> {
  if (!input.userId) return;

  // 1. Persist
  const notif = getCommentNotificationStore().create({ type: 'reply', ...input });

  // 2. Real-time via Socket.io
  const io = getIo();
  if (io) {
    io.to(`user:${input.userId}`).emit('comment:notification', notif);
  }

  // 3. Browser push (best-effort)
  if (vapidReady) {
    const subs = getPushSubs(input.userId);
    const payload = JSON.stringify({
      title: PUSH_LABEL.reply,
      body:  input.fromName ? `${input.fromName} replied on ${input.assetName}` : input.assetName,
      projectId: input.projectId,
      assetId:   input.assetId,
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
