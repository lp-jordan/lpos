import { NextRequest, NextResponse } from 'next/server';

const INGEST_URL     = process.env.INGEST_BASE_URL!
const INGEST_API_KEY = process.env.INGEST_API_KEY!

type Ctx = { params: Promise<{ projectId: string; token: string }> }

// PATCH /api/projects/[projectId]/delivery/[token]
// Body: { label?: string, expiresAt?: string }
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { token } = await params
  const body = await req.json() as { label?: string; expiresAt?: string }

  const payload: Record<string, string> = {}
  if (body.label     !== undefined) payload.label      = body.label
  if (body.expiresAt !== undefined) payload.expires_at = body.expiresAt

  const res = await fetch(`${INGEST_URL}/api/delivery/${token}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-api-key': INGEST_API_KEY },
    body:    JSON.stringify(payload),
    signal:  req.signal,
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.ok ? 200 : res.status })
}

// DELETE /api/projects/[projectId]/delivery/[token]
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { token } = await params

  const res = await fetch(`${INGEST_URL}/api/delivery/${token}`, {
    method:  'DELETE',
    headers: { 'x-api-key': INGEST_API_KEY },
    signal:  req.signal,
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.ok ? 200 : res.status })
}
