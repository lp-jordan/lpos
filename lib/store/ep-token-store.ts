/**
 * EditPanel auth token store
 *
 * One row per (user, machine) approval. Tokens are minted by the /ep/link
 * approval flow and delivered to the editpanel via the lpos-editpanel://
 * URL scheme callback. The raw token is only ever returned at mint time —
 * the database stores only its sha256 hash, so a DB dump cannot be used
 * to authenticate.
 *
 * Token format: 32 bytes of cryptographic random, base64url encoded (43 chars).
 *
 * Lookup flow:
 *   sha256(raw token, hex) → SELECT * FROM ep_tokens WHERE token_hash = ? AND revoked_at IS NULL
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getCoreDb } from './core-db';

export interface EpTokenRow {
  tokenId:     string;
  userId:      string;
  machineName: string;
  createdAt:   string;
  lastUsedAt:  string | null;
  revokedAt:   string | null;
}

interface DbRow {
  token_id:     string;
  user_id:      string;
  machine_name: string;
  token_hash:   string;
  created_at:   string;
  last_used_at: string | null;
  revoked_at:   string | null;
}

function rowToToken(row: DbRow): EpTokenRow {
  return {
    tokenId:     row.token_id,
    userId:      row.user_id,
    machineName: row.machine_name,
    createdAt:   row.created_at,
    lastUsedAt:  row.last_used_at,
    revokedAt:   row.revoked_at,
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRawToken(): string {
  // 32 bytes → 43 chars of base64url (no padding)
  return randomBytes(32).toString('base64url');
}

/**
 * Mint a new EditPanel token for (userId, machineName).
 * Returns the raw token (deliver once to the client) and the token row.
 */
export function mintEpToken(userId: string, machineName: string): { rawToken: string; token: EpTokenRow } {
  const db        = getCoreDb();
  const tokenId   = randomUUID();
  const rawToken  = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO ep_tokens (token_id, user_id, machine_name, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(tokenId, userId, machineName, tokenHash, createdAt);

  return {
    rawToken,
    token: { tokenId, userId, machineName, createdAt, lastUsedAt: null, revokedAt: null },
  };
}

/**
 * Verify a raw token from a request header. Returns the row if active, null otherwise.
 * Does NOT touch last_used_at — callers should call touchEpToken separately if they
 * want to record the hit (we keep these decoupled so cheap polling routes can skip the write).
 */
export function verifyEpToken(rawToken: string | null | undefined): EpTokenRow | null {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const row = getCoreDb()
    .prepare(`SELECT * FROM ep_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
    .get(tokenHash) as DbRow | undefined;
  return row ? rowToToken(row) : null;
}

/** Bump last_used_at to now for the given token row. */
export function touchEpToken(tokenId: string): void {
  getCoreDb()
    .prepare(`UPDATE ep_tokens SET last_used_at = ? WHERE token_id = ?`)
    .run(new Date().toISOString(), tokenId);
}

/** Mark a token revoked. Idempotent. */
export function revokeEpToken(tokenId: string): void {
  getCoreDb()
    .prepare(`UPDATE ep_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), tokenId);
}

/** List all tokens (active + revoked) for the admin Connected Devices page. */
export function listAllEpTokens(): EpTokenRow[] {
  return (getCoreDb()
    .prepare(`SELECT * FROM ep_tokens ORDER BY created_at DESC`)
    .all() as DbRow[]).map(rowToToken);
}

/** List active (non-revoked) tokens. */
export function listActiveEpTokens(): EpTokenRow[] {
  return (getCoreDb()
    .prepare(`SELECT * FROM ep_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`)
    .all() as DbRow[]).map(rowToToken);
}
