import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getAllUsers } from '@/lib/store/user-store';
import { readConsoleAlertsConfig, writeConsoleAlertsConfig } from '@/lib/store/console-alerts-config';

async function requireAdmin() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session || session.role !== 'admin') return null;
  return session;
}

// GET — list all users with their alert-enabled flag
export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const config = readConsoleAlertsConfig();
  const users = getAllUsers().filter((u) => u.id !== 'guest');
  const recipientIds = new Set(config.recipients.map((r) => r.userId));

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      slackEmail: u.slackEmail,
      enabled: recipientIds.has(u.id),
    })),
  });
}

// POST — save recipient list. Automatically captures SLACK_BOT_TOKEN from server env.
export async function POST(req: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json() as { recipientUserIds: string[] };
  const allUsers = getAllUsers();
  const userMap = new Map(allUsers.map((u) => [u.id, u]));

  const recipients = body.recipientUserIds
    .map((id) => {
      const u = userMap.get(id);
      if (!u) return null;
      return { userId: u.id, name: u.name, slackEmail: u.slackEmail ?? u.email };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const existing = readConsoleAlertsConfig();
  writeConsoleAlertsConfig({
    // Always refresh the token from env so it stays in sync with doppler
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? existing.slackBotToken ?? null,
    recipients,
  });

  return NextResponse.json({ ok: true, count: recipients.length });
}
