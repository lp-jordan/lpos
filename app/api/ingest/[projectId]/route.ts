import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getIngestDb } from '@/lib/ingest-db'

const INGEST_APP_URL = process.env.INGEST_APP_URL ?? ''

// ── GET — fetch token + submissions for a project ─────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const db = getIngestDb()

  const clientResult = await db.query(
    'SELECT id, token, first_name, welcome_name FROM ingest_clients WHERE lpos_project_id = $1 AND active = true',
    [projectId]
  )

  if (!clientResult.rows.length) {
    return NextResponse.json({ token: null, clientUrl: null, welcomeName: null, firstName: null, files: [] })
  }

  const { id, token, first_name, welcome_name } = clientResult.rows[0]

  const filesResult = await db.query(
    `SELECT file_name, file_size, mime_type, file_key, created_at,
            processed, promoted_to, promoted_at
     FROM ingest_submissions
     WHERE client_id = $1
     ORDER BY created_at DESC`,
    [id]
  )

  return NextResponse.json({
    token,
    clientUrl: `${INGEST_APP_URL}/c/${token}`,
    welcomeName: welcome_name ?? null,
    firstName: first_name ?? null,
    files: filesResult.rows,
  })
}

// ── PATCH — update per-link settings (custom welcome name) ────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const body = await req.json().catch(() => ({})) as { welcomeName?: string | null }

  // Empty / whitespace-only clears the override so the greeting falls back to the client name.
  const welcomeName =
    typeof body.welcomeName === 'string' && body.welcomeName.trim()
      ? body.welcomeName.trim().slice(0, 80)
      : null

  const db = getIngestDb()
  const result = await db.query(
    'UPDATE ingest_clients SET welcome_name = $2 WHERE lpos_project_id = $1 AND active = true RETURNING welcome_name',
    [projectId, welcomeName]
  )

  if (!result.rows.length) {
    return NextResponse.json({ error: 'No upload link for this project' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, welcomeName: result.rows[0].welcome_name ?? null })
}

// ── POST — create a token for a project ──────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const { clientName } = await req.json() as { clientName: string }
  if (!clientName) return NextResponse.json({ error: 'clientName required' }, { status: 400 })

  const db = getIngestDb()
  const token = randomBytes(8).toString('hex')

  await db.query(
    `INSERT INTO ingest_clients (token, lpos_project_id, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (lpos_project_id) DO NOTHING`,
    [token, projectId, clientName]
  )

  // Return whatever token ended up in the DB (handles race condition)
  const result = await db.query(
    'SELECT token FROM ingest_clients WHERE lpos_project_id = $1',
    [projectId]
  )

  const finalToken = result.rows[0].token
  return NextResponse.json({
    token: finalToken,
    clientUrl: `${INGEST_APP_URL}/c/${finalToken}`,
  })
}
