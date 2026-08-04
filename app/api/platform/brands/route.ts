import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { listBrandPresets, createBrandPreset } from '@/lib/store/platform-pass-store';
import type { BrandConfig } from '@/lib/platform/tile-background';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

export async function GET() {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ presets: listBrandPresets() });
}

export async function POST(req: NextRequest) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { name?: string; config?: BrandConfig };
  if (!body.name?.trim() || !body.config) return NextResponse.json({ error: 'name and config required' }, { status: 400 });
  return NextResponse.json({ preset: createBrandPreset(body.name, body.config) }, { status: 201 });
}
