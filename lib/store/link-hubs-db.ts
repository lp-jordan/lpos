/**
 * Link Hubs store — standalone client-delivery hubs.
 *
 * A hub is a first-class container (NOT derived from a client): a chosen set of
 * finished videos + a list of authorized login emails + a cosmetic owner label.
 * client_title + share_token live on the membership (hub_items), so the same
 * asset can appear in two hubs with a different title and a different link.
 *
 * LPOS owns this; on save the projection is pushed to the external delivery app
 * (see lib/services/link-hub-delivery.ts). Backed by its own link-hubs.sqlite at
 * the DATA_DIR root — auto-included in the nightly R2 backup + WAL checkpointing
 * via the globalThis singleton convention (see db-registry.ts, backup-service.ts).
 *
 * Cloned from lib/store/canonical-asset-db.ts (node:sqlite DatabaseSync pattern).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'link-hubs.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_link_hubs_db: DatabaseSync | undefined;
}

export type HubOwnerType = 'client' | 'person' | 'leaderpass';

export interface LinkHub {
  id: string;
  name: string;
  owner_label: string;
  owner_type: HubOwnerType;
  created_at: string;
  updated_at: string;
}

export interface LinkHubSummary extends LinkHub {
  video_count: number;
  access_count: number;
}

export interface LinkHubItem {
  asset_id: string;
  project_id: string;
  client_title: string;
  share_token: string;
  sort_order: number;
}

export interface LinkHubDetail {
  hub: LinkHub;
  items: LinkHubItem[];
  access: string[];
}

function initSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS hubs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_label TEXT NOT NULL,
      owner_type  TEXT NOT NULL DEFAULT 'client',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hub_access_emails (
      hub_id TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      email  TEXT NOT NULL,
      PRIMARY KEY (hub_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_lh_access_email ON hub_access_emails(email);
    CREATE TABLE IF NOT EXISTS hub_items (
      hub_id       TEXT NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      asset_id     TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      client_title TEXT NOT NULL,
      share_token  TEXT NOT NULL UNIQUE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hub_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lh_items_token ON hub_items(share_token);
  `);
}

export function getLinkHubsDb(): DatabaseSync {
  if (globalThis.__lpos_link_hubs_db) return globalThis.__lpos_link_hubs_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_link_hubs_db = db;
  return db;
}

export function getLinkHubsDbPath(): string {
  return DB_PATH;
}

// ── tokens / ids ──────────────────────────────────────────────────────────────

const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars

function newShareToken(db: DatabaseSync): string {
  const stmt = db.prepare('SELECT 1 FROM hub_items WHERE share_token = ?');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    let token = '';
    for (let i = 0; i < 8; i += 1) token += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    if (!stmt.get(token)) return token;
  }
  throw new Error('could not generate a unique share token');
}

// ── reads ─────────────────────────────────────────────────────────────────────

export function listHubs(): LinkHubSummary[] {
  return getLinkHubsDb()
    .prepare(
      `SELECT h.*,
              (SELECT COUNT(*) FROM hub_items i WHERE i.hub_id = h.id)          AS video_count,
              (SELECT COUNT(*) FROM hub_access_emails a WHERE a.hub_id = h.id)  AS access_count
       FROM hubs h
       ORDER BY h.updated_at DESC`,
    )
    .all() as LinkHubSummary[];
}

export function getHub(hubId: string): LinkHub | undefined {
  return getLinkHubsDb().prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as LinkHub | undefined;
}

export function getHubDetail(hubId: string): LinkHubDetail | undefined {
  const db = getLinkHubsDb();
  const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as LinkHub | undefined;
  if (!hub) return undefined;
  const items = db
    .prepare(
      `SELECT asset_id, project_id, client_title, share_token, sort_order
       FROM hub_items WHERE hub_id = ? ORDER BY sort_order, client_title`,
    )
    .all(hubId) as LinkHubItem[];
  const access = (db.prepare('SELECT email FROM hub_access_emails WHERE hub_id = ? ORDER BY email').all(hubId) as Array<{ email: string }>).map(
    (r) => r.email,
  );
  return { hub, items, access };
}

// ── writes ────────────────────────────────────────────────────────────────────

export function createHub(input: {
  name: string;
  owner_label: string;
  owner_type: HubOwnerType;
  firstEmail?: string;
}): LinkHub {
  const db = getLinkHubsDb();
  const now = new Date().toISOString();
  const id = `lh_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO hubs (id, name, owner_label, owner_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name.trim(), (input.owner_label || input.name).trim(), input.owner_type, now, now);
  const email = input.firstEmail?.trim().toLowerCase();
  if (email) {
    db.prepare('INSERT OR IGNORE INTO hub_access_emails (hub_id, email) VALUES (?, ?)').run(id, email);
  }
  return getHub(id)!;
}

export interface SaveHubInput {
  name: string;
  owner_label: string;
  owner_type: HubOwnerType;
  items: Array<{ asset_id: string; project_id: string; client_title: string }>;
  access: string[];
}

/**
 * Full-replace a hub's videos + access. Share tokens are STABLE — an asset that
 * stays in the hub keeps its existing /v/{token}; only newly added assets mint one.
 */
export function saveHub(hubId: string, input: SaveHubInput): LinkHubDetail {
  const db = getLinkHubsDb();
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const existing = db.prepare('SELECT asset_id, share_token FROM hub_items WHERE hub_id = ?').all(hubId) as Array<{
      asset_id: string;
      share_token: string;
    }>;
    const tokenByAsset = new Map(existing.map((r) => [r.asset_id, r.share_token]));

    db.prepare('UPDATE hubs SET name = ?, owner_label = ?, owner_type = ?, updated_at = ? WHERE id = ?').run(
      input.name.trim(),
      (input.owner_label || input.name).trim(),
      input.owner_type,
      now,
      hubId,
    );

    db.prepare('DELETE FROM hub_items WHERE hub_id = ?').run(hubId);
    const insItem = db.prepare(
      `INSERT INTO hub_items (hub_id, asset_id, project_id, client_title, share_token, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    input.items.forEach((it, i) => {
      const token = tokenByAsset.get(it.asset_id) ?? newShareToken(db);
      insItem.run(hubId, it.asset_id, it.project_id, (it.client_title || '').trim() || it.asset_id, token, i);
    });

    db.prepare('DELETE FROM hub_access_emails WHERE hub_id = ?').run(hubId);
    const insEmail = db.prepare('INSERT OR IGNORE INTO hub_access_emails (hub_id, email) VALUES (?, ?)');
    const seen = new Set<string>();
    for (const raw of input.access) {
      const email = raw.trim().toLowerCase();
      if (email && !seen.has(email)) {
        seen.add(email);
        insEmail.run(hubId, email);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getHubDetail(hubId)!;
}

export function deleteHub(hubId: string): void {
  getLinkHubsDb().prepare('DELETE FROM hubs WHERE id = ?').run(hubId);
}
