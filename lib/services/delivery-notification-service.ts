/**
 * Delivery Notification Service
 *
 * Called from the /api/internal/delivery-trouble endpoint when the ingest
 * server forwards a recipient's "Having trouble?" submission.
 *
 * Resolves the target user (the delivery's creator, or all admins as a fallback),
 * persists a delivery_notifications row per recipient, emits via Socket.io to
 * each user's room, and sends a Slack DM via the existing slack-service.
 */

import { getDeliveryNotificationStore, getIo } from '@/lib/services/container';
import { getUserById, getUserByEmail } from '@/lib/store/user-store';
import { getAdmins } from '@/lib/store/admin-store';
import { sendSlackDeliveryTroubleDm } from '@/lib/services/slack-service';

export interface DeliveryTroublePayload {
  deliveryToken:      string;
  projectName:        string;
  clientName:         string | null;
  label:              string | null;
  description:        string | null;
  queueSummary:       string | null;
  userAgent:          string | null;
  /** Email of the LPOS user who created the delivery link, if known. */
  createdByUserEmail: string | null;
  /** Optional dashboard project ID — used to build the click-through link. */
  projectId:          string | null;
}

/**
 * Build the absolute dashboard URL the recipient's "trouble" notification
 * should deep-link to. Uses APP_BASE_URL (preferred) or NEXTAUTH_URL as the
 * origin, falling back to a relative path if neither is set.
 */
function buildHref(projectId: string | null): string | null {
  if (!projectId) return null;
  const origin = (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
  const path = `/projects/${projectId}?panel=delivery`;
  return origin ? `${origin}${path}` : path;
}

/** Resolve the list of user IDs that should receive the notification. */
function resolveRecipients(createdByUserEmail: string | null): string[] {
  if (createdByUserEmail) {
    const creator = getUserByEmail(createdByUserEmail);
    if (creator) return [creator.id];
    console.warn(
      `[delivery-notif] creator email ${createdByUserEmail} did not match any user — falling back to admins`,
    );
  }
  // Fallback: notify every admin who has a corresponding user row
  const adminEmails = getAdmins();
  const ids: string[] = [];
  for (const email of adminEmails) {
    const u = getUserByEmail(email);
    if (u) ids.push(u.id);
  }
  return ids;
}

export async function notifyDeliveryTrouble(input: DeliveryTroublePayload): Promise<void> {
  const recipients = resolveRecipients(input.createdByUserEmail);
  if (recipients.length === 0) {
    console.warn(
      `[delivery-notif] no recipients resolved for delivery ${input.deliveryToken} — alert dropped`,
    );
    return;
  }

  const href = buildHref(input.projectId);
  const store = getDeliveryNotificationStore();
  const io = getIo();

  for (const userId of recipients) {
    const notif = store.create({
      userId,
      type:          'trouble_reported',
      deliveryToken: input.deliveryToken,
      projectName:   input.projectName,
      clientName:    input.clientName,
      label:         input.label,
      description:   input.description,
      queueSummary:  input.queueSummary,
      userAgent:     input.userAgent,
      href,
    });

    // Real-time fan-out to the open NotifBell in any session for this user
    if (io) io.to(`user:${userId}`).emit('delivery:notification', notif);

    // Slack DM (best-effort)
    const user = getUserById(userId);
    if (user) {
      sendSlackDeliveryTroubleDm({
        email:        user.slackEmail ?? user.email,
        projectName:  input.projectName,
        clientName:   input.clientName,
        description:  input.description,
        queueSummary: input.queueSummary,
        userAgent:    input.userAgent,
        href,
      }).catch((err: unknown) => {
        console.warn('[delivery-notif] Slack DM failed:', err);
      });
    }
  }
}
