import { NextResponse } from 'next/server';
import { getClientStore } from '@/lib/services/container';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ clientName: string }> },
) {
  const { clientName } = await params;
  const name = decodeURIComponent(clientName);
  const deleted = getClientStore().deleteByName(name);
  if (!deleted) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
