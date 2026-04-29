/**
 * Slack Service
 *
 * Sends task notification DMs to users via Slack bot.
 * Uses users.lookupByEmail to resolve LPOS user emails to Slack user IDs,
 * then posts a DM via chat.postMessage.
 *
 * Requires SLACK_BOT_TOKEN in env. Silently skips if not configured.
 */

import type { TaskNotifType } from '@/lib/models/task-notification';

const TOKEN = process.env.SLACK_BOT_TOKEN;

// In-memory cache: email → Slack user ID. Capped at 500 entries — evicts the
// oldest entry when full so the map never grows without bound.
const emailToSlackId = new Map<string, string>();
const EMAIL_CACHE_MAX = 500;

async function lookupSlackUserId(email: string): Promise<string | null> {
  const cached = emailToSlackId.get(email);
  if (cached) return cached;

  const res = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  const data = await res.json() as { ok: boolean; user?: { id: string }; error?: string };

  if (!data.ok || !data.user) {
    console.warn(`[slack] Could not resolve Slack user for ${email}: ${data.error ?? 'unknown'}`);
    return null;
  }

  if (emailToSlackId.size >= EMAIL_CACHE_MAX) {
    emailToSlackId.delete(emailToSlackId.keys().next().value!);
  }
  emailToSlackId.set(email, data.user.id);
  return data.user.id;
}

const LABELS: Record<TaskNotifType, (fromName?: string) => string> = {
  assigned:       (from) => `You were assigned a task${from ? ` by ${from}` : ''}`,
  mentioned:      (from) => `${from ?? 'Someone'} mentioned you in a task`,
  status_changed: ()     => 'A task you\'re on has been updated',
  commented:      (from) => `${from ?? 'Someone'} commented on a task`,
};

export async function sendSlackTaskDm(input: {
  email: string;
  type: TaskNotifType;
  taskTitle: string;
  fromName?: string;
}): Promise<void> {
  if (!TOKEN) return;

  const slackUserId = await lookupSlackUserId(input.email);
  if (!slackUserId) return;

  const text = `${LABELS[input.type](input.fromName)}\n> ${input.taskTitle}`;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: slackUserId, text }),
  });

  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) {
    console.warn(`[slack] chat.postMessage failed: ${data.error ?? 'unknown'}`);
  }
}
