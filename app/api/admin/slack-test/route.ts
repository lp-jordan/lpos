import { type NextRequest, NextResponse } from 'next/server';
import { requireRole, getSession } from '@/lib/services/api-auth';
import { getUserById } from '@/lib/store/user-store';
import { sendSlackTaskDm } from '@/lib/services/slack-service';

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const session = await getSession(req);
  const user = session ? getUserById(session.userId) : null;

  if (!user) {
    return NextResponse.json({ error: 'Could not resolve your user record.' }, { status: 500 });
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    return NextResponse.json({ error: 'SLACK_BOT_TOKEN is not configured.' }, { status: 503 });
  }

  try {
    await sendSlackTaskDm({
      email: user.email,
      type: 'assigned',
      taskTitle: 'This is a test notification from LPOS',
      fromName: 'LPOS Admin',
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
