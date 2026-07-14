import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { INGEST_URL, INGEST_API_KEY } from '@/lib/services/delivery-upload';

type Ctx = { params: Promise<{ projectId: string; token: string; itemId: string }> }

// DELETE /api/projects/[projectId]/delivery/[token]/assets/[itemId]
// Removes a single video from an existing delivery link (Edit videos → uncheck).
// The ingest server deletes the row and its R2 objects.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { projectId, token, itemId } = await params

  const project = getProjectStore().getById(projectId)
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const res = await fetch(`${INGEST_URL}/api/delivery/${token}/assets/${encodeURIComponent(itemId)}`, {
    method:  'DELETE',
    headers: { 'x-api-key': INGEST_API_KEY },
  })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json(data, { status: res.ok ? 200 : res.status })
}
