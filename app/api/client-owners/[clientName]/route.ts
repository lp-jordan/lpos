import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getClientOwnerStore } from '@/lib/services/container';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ clientName: string }> },
) {
  const { clientName } = await params;
  const decoded = decodeURIComponent(clientName);
  const body = await req.json() as { userId?: string };
  if (!body.userId?.trim()) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }
  getClientOwnerStore().set(decoded, body.userId.trim());
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clientName: string }> },
) {
  const { clientName } = await params;
  getClientOwnerStore().remove(decodeURIComponent(clientName));
  return NextResponse.json({ ok: true });
}
