import pg from 'pg'

let pool: pg.Pool | null = null

export function getIngestDb(): pg.Pool {
  if (!pool) {
    if (!process.env.INGEST_DATABASE_URL) {
      throw new Error('INGEST_DATABASE_URL is not set')
    }
    pool = new pg.Pool({
      connectionString: process.env.INGEST_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  }
  return pool
}
