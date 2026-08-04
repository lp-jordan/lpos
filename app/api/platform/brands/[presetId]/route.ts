import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { deleteBrandPreset } from '@/lib/store/platform-pass-store';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ presetId: string }> }) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { presetId } = await params;
  deleteBrandPreset(presetId);
  return NextResponse.json({ ok: true });
}
