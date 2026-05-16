import { NextResponse } from 'next/server';
import { getClientStore, getProspectStore } from '@/lib/services/container';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ clientName: string }> },
) {
  const { clientName } = await params;
  const name = decodeURIComponent(clientName);

  const client = getClientStore().getByName(name);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  // Cascade: make the linked People entry inactive + archived
  if (client.prospectId) {
    const prospectStore = getProspectStore();
    const prospect = prospectStore.getById(client.prospectId);
    if (prospect) {
      prospectStore.update(client.prospectId, { status: 'inactive' }, 'system');
      prospectStore.archive(client.prospectId);
    }
  }

  getClientStore().deleteByName(name);
  return NextResponse.json({ ok: true });
}
