import { NextRequest, NextResponse } from 'next/server'
import { getIngestDb } from '@/lib/ingest-db'

const INGEST_APP_URL = (() => {
  const url = process.env.INGEST_APP_URL ?? ''
  if (url && !/^https?:\/\//i.test(url)) return `https://${url}`
  return url
})()

// Proxies download through the ingest app's signed URL endpoint
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const key = req.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'No key' }, { status: 400 })

  const db = getIngestDb()

  // Resolve token for this project
  const result = await db.query(
    'SELECT token FROM ingest_clients WHERE lpos_project_id = $1 AND active = true',
    [projectId]
  )
  if (!result.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { token } = result.rows[0]
  return NextResponse.redirect(`${INGEST_APP_URL}/c/${token}/download?key=${encodeURIComponent(key)}`)
}
