import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore } from '@/lib/services/container';

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
    projectId?: string | null;
    clientName?: string | null;
    assignedTo?: string[];
  };

  if (!body.description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }

  const task = getTaskStore().create({
    description: body.description,
    projectId: body.projectId ?? null,
    clientName: body.clientName ?? null,
    createdBy: session.userId,
    assignedTo: body.assignedTo,
  });

  return NextResponse.json({ task }, { status: 201 });
}
