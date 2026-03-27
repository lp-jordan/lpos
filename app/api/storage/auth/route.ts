import { NextRequest, NextResponse } from 'next/server';
import { getClearedStorageAdminCookie } from '@/lib/services/storage-auth';

export async function POST(req: NextRequest) {
  void req;
  return NextResponse.json({ ok: true, bootstrapped: true, unlocked: true });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true, unlocked: false });
  const cookie = getClearedStorageAdminCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
