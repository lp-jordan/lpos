import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getClientStore, getProspectStore } from '@/lib/services/container';
import { requireProspectsAccess } from '@/lib/services/api-auth';
import { renameClientFolder } from '@/lib/services/drive-folder-service';

/**
 * PATCH /api/clients/[clientName] — atomically RENAME a client everywhere.
 *
 * Body: { newName: string }
 *
 * Replaces the old client-side fan-out (per-project clientName PATCHes +
 * owner re-key) that forked a duplicate prospect and stranded the clients
 * table + Drive folder. ClientStore.rename() converts the client in place
 * across all name-keyed core-db tables in one transaction; the Drive folder
 * cache is re-keyed afterward.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ clientName: string }> },
) {
  const deny = await requireProspectsAccess(req);
  if (deny) return deny;

  const { clientName } = await params;
  const oldName = decodeURIComponent(clientName);

  const body    = await req.json().catch(() => ({})) as { newName?: unknown };
  const newName = typeof body.newName === 'string' ? body.newName.trim() : '';

  if (!newName) {
    return NextResponse.json({ error: 'A new client name is required.' }, { status: 400 });
  }
  if (newName === oldName) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const store = getClientStore();
  if (!store.getByName(oldName)) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }
  if (store.getByName(newName)) {
    return NextResponse.json(
      { error: `A client named "${newName}" already exists. Merging two clients isn't supported yet — pick a name that isn't already in use.` },
      { status: 409 },
    );
  }

  let result;
  try {
    result = store.rename(oldName, newName);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
  if (!result) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  // Re-key the Drive folder cache + rename the Drive folder (best-effort, async).
  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (driveId) void renameClientFolder(driveId, oldName, newName);

  return NextResponse.json({ ok: true, ...result });
}

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
