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
    'SELECT id, token FROM ingest_clients WHERE lpos_project_id = $1 AND active = true',
    [projectId]
  )

  if (!clientResult.rows.length) {
    return NextResponse.json({ token: null, clientUrl: null, files: [] })
  }

  const { id, token } = clientResult.rows[0]

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
    files: filesResult.rows,
  })
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
