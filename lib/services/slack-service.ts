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

const LABELS: Record<TaskNotifType, (fromName?: string, emoji?: string) => string> = {
  assigned:             (from) => `You were assigned a task${from ? ` by ${from}` : ''}`,
  mentioned:            (from) => `${from ?? 'Someone'} mentioned you in a task`,
  status_changed:       ()     => 'A task you\'re on has been updated',
  commented:            (from) => `${from ?? 'Someone'} commented on a task`,
  handoff:              (from) => `${from ?? 'Someone'} handed off a task to you`,
  handoff_acknowledged: (from) => `${from ?? 'Someone'} acknowledged your handoff`,
  handoff_stale:        ()     => 'A handoff to you has been idle — please take a look',
  review_stale:         ()     => 'A task you\'re on has been sitting in Review — post an update or acknowledge',
  reacted:              (from, emoji) => `${from ?? 'Someone'} reacted ${emoji ?? ''}`.trim() + ' to your comment',
};

export async function sendSlackTaskDm(input: {
  email: string;
  type: TaskNotifType;
  taskTitle: string;
  fromName?: string;
  emoji?: string;
}): Promise<void> {
  if (!TOKEN) return;

  const slackUserId = await lookupSlackUserId(input.email);
  if (!slackUserId) return;

  const text = `${LABELS[input.type](input.fromName, input.emoji)}\n> ${input.taskTitle}`;
  await postDm(slackUserId, text);
}

/**
 * Send a delivery trouble report as a Slack DM. Used by the delivery
 * notification service when a recipient clicks "Having trouble?" on a
 * delivery link's public download page.
 */
export async function sendSlackDeliveryTroubleDm(input: {
  email:        string;
  projectName:  string;
  clientName:   string | null;
  description:  string | null;
  queueSummary: string | null;
  userAgent:    string | null;
  /** Short, readable URL to the delivery panel for this project. */
  href:         string | null;
}): Promise<void> {
  if (!TOKEN) return;

  const slackUserId = await lookupSlackUserId(input.email);
  if (!slackUserId) return;

  const title = input.clientName
    ? `*"${input.projectName}"* — ${input.clientName}`
    : `*"${input.projectName}"*`;

  const lines: string[] = [
    ':rotating_light: *Delivery trouble report*',
    title,
  ];
  if (input.description) lines.push(`Recipient says: "${input.description}"`);
  if (input.queueSummary) lines.push(`Queue: ${input.queueSummary}`);
  if (input.userAgent)    lines.push(`Browser: ${input.userAgent}`);
  if (input.href)         lines.push(`<${input.href}|Open delivery panel →>`);

  await postDm(slackUserId, lines.join('\n'));
}

export async function sendSlackDeliveryExpiredDm(input: {
  email:       string;
  projectName: string;
  clientName:  string | null;
  label:       string | null;
  href:        string | null;
}): Promise<void> {
  if (!TOKEN) return;

  const slackUserId = await lookupSlackUserId(input.email);
  if (!slackUserId) return;

  const title = input.clientName
    ? `*"${input.projectName}"* — ${input.clientName}`
    : `*"${input.projectName}"*`;

  const lines: string[] = [
    ':timer_clock: *Delivery link expired*',
    title,
  ];
  if (input.label) lines.push(`Label: ${input.label}`);
  if (input.href)  lines.push(`<${input.href}|Open delivery panel →>`);

  await postDm(slackUserId, lines.join('\n'));
}

export async function sendSlackColdStorageReviewDm(input: {
  email: string;
  pendingCount: number;
  href: string | null;
}): Promise<void> {
  if (!TOKEN)              return;
  if (input.pendingCount <= 0) return;

  const slackUserId = await lookupSlackUserId(input.email);
  if (!slackUserId) return;

  const noun = input.pendingCount === 1 ? 'file' : 'files';
  const lines: string[] = [
    ':snowflake: *Cold storage: review required*',
    `${input.pendingCount} ${noun} have aged past the retention window and are awaiting your approval before LPOS removes them from B2.`,
    'Open the storage page to Approve or Spare each one — nothing will be deleted automatically.',
  ];
  if (input.href) lines.push(`<${input.href}|Review pending deletions →>`);

  await postDm(slackUserId, lines.join('\n'));
}

export async function sendSlackCameraIdleDm(input: {
  email: string;
  hoursSinceLastConnection: number;
}): Promise<void> {
  if (!TOKEN) return;

  const slackUserId = await lookupSlackUserId(input.email);
  if (!slackUserId) return;

  const lines: string[] = [
    ':camera_with_flash: *Studio cameras have been dark*',
    `No Sony camera has connected in about ${input.hoursSinceLastConnection}h. The camera bridge has auto-idled and will resume on its own the moment a camera comes back on the network.`,
    'Nothing to do unless you expected a camera to be live — this is just a heads-up.',
  ];

  await postDm(slackUserId, lines.join('\n'));
}

async function postDm(slackUserId: string, text: string): Promise<void> {
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
