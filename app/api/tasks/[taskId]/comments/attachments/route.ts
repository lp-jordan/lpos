import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getTaskStore } from '@/lib/services/container';
import { uploadAttachment } from '@/lib/services/r2-attachments';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

type Params = { params: Promise<{ taskId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { taskId } = await params;
  if (!getTaskStore().getById(taskId)) {
    return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 10 MB limit.' }, { status: 413 });
  }

  const ext    = path.extname(file.name).toLowerCase();
  const key    = `attachments/tasks/${taskId}/${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime   = file.type || 'application/octet-stream';

  await uploadAttachment(key, buffer, mime);

  return NextResponse.json({ key, name: file.name, mime, size: file.size }, { status: 201 });
}
