/**
 * Share links store — the unified Share system (review + delivery + hub + internal).
 *
 * One Share = a set of videos + who can open it + a set of capability switches
 * (comments, download, reshare, transcripts, internal). Shares always show
 * each video's newest cut. Every link
 * renders in the same viewer; the switches only add or remove pieces of it.
 *
 * A share is either:
 *   - pass-backed (`pass_id` set): its videos, order, categories and client-facing
 *     titles come live from the Platform pass tree, so the pass IS the share and
 *     nobody curates the same videos twice; or
 *   - ad-hoc (`pass_id` null): an explicit, ordered list in share_link_items.
 * For pass-backed shares, share_link_items still holds per-video state (the
 * per-video reshare token) but not membership.
 *
 * Every change is live — there is no publish/deliver step. What used to be
 * "Deliver" is just switches: Download on, Comments off, Lock cuts on.
 *
 * Backed by its own share-links.sqlite at the DATA_DIR root — auto-included in
 * the nightly R2 backup + WAL checkpointing via the globalThis singleton
 * convention (see db-registry.ts, backup-service.ts). Pattern cloned from
 * lib/store/link-hubs-db.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'share-links.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_share_links_db: DatabaseSync | undefined;
}

export type ShareAudience = 'link' | 'email' | 'staff';

export interface ShareCaps {
  comments:    boolean;
  download:    boolean;
  reshare:     boolean;
  transcripts: boolean;
  /** Staff-only share: LPOS sign-in required, internal comments visible. Driven by audience 'staff'. */
  internal:    boolean;
}

export const SHARE_CAP_KEYS: Array<keyof ShareCaps> = ['comments', 'download', 'reshare', 'transcripts', 'internal'];

export const SHARE_PRESETS: Record<'review' | 'internal', { caps: ShareCaps }> = {
  review:   { caps: { comments: true, download: false, reshare: true,  transcripts: true, internal: false } },
  internal: { caps: { comments: true, download: false, reshare: false, transcripts: true, internal: true  } },
};

export interface ShareLink {
  id:         string;
  token:      string;
  name:       string;
  passId:     string | null;
  caps:       ShareCaps;
  audience:   ShareAudience;
  emails:     string[];
  createdBy:  string | null;
  createdAt:  string;
  updatedAt:  string;
  revokedAt:  string | null;
}

export interface ShareLinkItem {
  assetId:           string;
  projectId:         string;
  position:          number;
  clientTitle:       string | null;
  /** Stable per-video public link token (one-click reshare). */
  videoToken:        string;
}

interface ShareRow {
  id: string; token: string; name: string; pass_id: string | null; stage: string;
  caps: string; audience: string; created_by: string | null;
  created_at: string; updated_at: string; revoked_at: string | null;
}

interface ItemRow {
  share_id: string; asset_id: string; project_id: string; position: number;
  client_title: string | null; pinned_version_id: string | null; pinned_version_number: number | null;
  video_token: string; in_list: number;
}

function initSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id          TEXT PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      pass_id     TEXT,
      stage       TEXT NOT NULL DEFAULT 'review',
      caps        TEXT NOT NULL,
      audience    TEXT NOT NULL DEFAULT 'link',
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      revoked_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sl_pass ON share_links(pass_id);
    CREATE TABLE IF NOT EXISTS share_link_emails (
      share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
      email    TEXT NOT NULL,
      PRIMARY KEY (share_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_sl_email ON share_link_emails(email);
    -- in_list = 1: the video is a member of an ad-hoc share's list. Pass-backed
    -- shares derive membership from the pass and use rows only for per-video
    -- state (token, pins), so their rows carry in_list = 0.
    CREATE TABLE IF NOT EXISTS share_link_items (
      share_id              TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
      asset_id              TEXT NOT NULL,
      project_id            TEXT NOT NULL,
      position              INTEGER NOT NULL DEFAULT 0,
      client_title          TEXT,
      pinned_version_id     TEXT,
      pinned_version_number INTEGER,
      video_token           TEXT NOT NULL UNIQUE,
      in_list               INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (share_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sl_items_token ON share_link_items(video_token);
  `);
}

export function getShareLinksDb(): DatabaseSync {
  if (globalThis.__lpos_share_links_db) return globalThis.__lpos_share_links_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_share_links_db = db;
  return db;
}

// ── tokens / ids ──────────────────────────────────────────────────────────────

const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars

function newToken(db: DatabaseSync, sql: string): string {
  const stmt = db.prepare(sql);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    let token = '';
    for (let i = 0; i < 8; i += 1) token += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    if (!stmt.get(token)) return token;
  }
  throw new Error('could not generate a unique token');
}

// ── mappers ───────────────────────────────────────────────────────────────────

// The `stage` and pinned_version_* columns are retired (from the Deliver / Lock
// cuts era); shares now always show each video's newest cut.
function parseCaps(raw: string): ShareCaps {
  let parsed: Partial<ShareCaps> = {};
  try { parsed = JSON.parse(raw) as Partial<ShareCaps>; } catch { /* default all off */ }
  const caps = {} as ShareCaps;
  for (const k of SHARE_CAP_KEYS) caps[k] = !!parsed[k];
  return caps;
}

function rowToShare(row: ShareRow, emails: string[]): ShareLink {
  return {
    id:        row.id,
    token:     row.token,
    name:      row.name,
    passId:    row.pass_id,
    caps:      parseCaps(row.caps),
    audience:  row.audience === 'email' || row.audience === 'staff' ? row.audience : 'link',
    emails,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function rowToItem(row: ItemRow): ShareLinkItem {
  return {
    assetId:             row.asset_id,
    projectId:           row.project_id,
    position:            row.position,
    clientTitle:         row.client_title,
    videoToken:          row.video_token,
  };
}

function emailsFor(db: DatabaseSync, shareId: string): string[] {
  return (db.prepare('SELECT email FROM share_link_emails WHERE share_id = ? ORDER BY email').all(shareId) as Array<{ email: string }>)
    .map((r) => r.email);
}

// ── reads ─────────────────────────────────────────────────────────────────────

export function listShareLinks(): ShareLink[] {
  const db = getShareLinksDb();
  const rows = db.prepare('SELECT * FROM share_links WHERE revoked_at IS NULL ORDER BY updated_at DESC').all() as unknown as ShareRow[];
  return rows.map((r) => rowToShare(r, emailsFor(db, r.id)));
}

export function getShareLink(id: string): ShareLink | null {
  const db = getShareLinksDb();
  const row = db.prepare('SELECT * FROM share_links WHERE id = ?').get(id) as unknown as ShareRow | undefined;
  return row ? rowToShare(row, emailsFor(db, row.id)) : null;
}

export function getShareLinkByToken(token: string): ShareLink | null {
  const db = getShareLinksDb();
  const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token) as unknown as ShareRow | undefined;
  return row ? rowToShare(row, emailsFor(db, row.id)) : null;
}

export function getShareLinkForPass(passId: string): ShareLink | null {
  const db = getShareLinksDb();
  const row = db.prepare('SELECT * FROM share_links WHERE pass_id = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1')
    .get(passId) as unknown as ShareRow | undefined;
  return row ? rowToShare(row, emailsFor(db, row.id)) : null;
}

/** Ad-hoc list members, in order. Empty for pass-backed shares. */
export function listShareItems(shareId: string): ShareLinkItem[] {
  const rows = getShareLinksDb()
    .prepare('SELECT * FROM share_link_items WHERE share_id = ? AND in_list = 1 ORDER BY position, rowid')
    .all(shareId) as unknown as ItemRow[];
  return rows.map(rowToItem);
}

/** Per-video state (token, pins) for every video the share has touched, keyed by asset id. */
export function getShareItemState(shareId: string): Map<string, ShareLinkItem> {
  const rows = getShareLinksDb().prepare('SELECT * FROM share_link_items WHERE share_id = ?').all(shareId) as unknown as ItemRow[];
  return new Map(rows.map((r) => [r.asset_id, rowToItem(r)]));
}

/** Resolve a per-video reshare token → (share, asset). */
export function getShareItemByVideoToken(videoToken: string): { share: ShareLink; item: ShareLinkItem } | null {
  const db = getShareLinksDb();
  const row = db.prepare('SELECT * FROM share_link_items WHERE video_token = ?').get(videoToken) as unknown as ItemRow | undefined;
  if (!row) return null;
  const share = getShareLink(row.share_id);
  return share ? { share, item: rowToItem(row) } : null;
}

// ── writes ────────────────────────────────────────────────────────────────────

export interface CreateShareInput {
  name:      string;
  passId?:   string | null;
  preset?:   keyof typeof SHARE_PRESETS;
  caps?:     Partial<ShareCaps>;
  audience?: ShareAudience;
  emails?:   string[];
  items?:    Array<{ assetId: string; projectId: string; clientTitle?: string | null }>;
  createdBy?: string | null;
}

export function createShareLink(input: CreateShareInput): ShareLink {
  const db = getShareLinksDb();
  const preset = SHARE_PRESETS[input.preset ?? 'review'];
  const caps: ShareCaps = { ...preset.caps, ...(input.caps ?? {}) };
  const audience: ShareAudience = caps.internal ? 'staff' : (input.audience ?? 'link');
  const id = crypto.randomUUID();
  const token = newToken(db, 'SELECT 1 FROM share_links WHERE token = ?');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO share_links (id, token, name, pass_id, stage, caps, audience, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, token, input.name.trim() || 'Untitled share', input.passId ?? null, 'review', JSON.stringify(caps), audience,
      input.createdBy ?? null, now, now);
    for (const email of normaliseEmails(input.emails ?? [])) {
      db.prepare('INSERT OR IGNORE INTO share_link_emails (share_id, email) VALUES (?, ?)').run(id, email);
    }
    if (!input.passId) {
      (input.items ?? []).forEach((it, i) => upsertItemRow(db, id, it.assetId, it.projectId, { position: i, clientTitle: it.clientTitle ?? null, inList: true }));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getShareLink(id)!;
}

export interface ShareLinkPatch {
  name?:     string;
  caps?:     Partial<ShareCaps>;
  audience?: ShareAudience;
  emails?:   string[];
}

export function updateShareLink(id: string, patch: ShareLinkPatch): ShareLink | null {
  const db = getShareLinksDb();
  const current = getShareLink(id);
  if (!current) return null;
  const caps: ShareCaps = { ...current.caps, ...(patch.caps ?? {}) };
  let audience = patch.audience ?? current.audience;
  // Internal and staff-only are the same thing seen from two controls — keep them in step.
  if (patch.caps && 'internal' in patch.caps) audience = caps.internal ? 'staff' : (audience === 'staff' ? 'link' : audience);
  if (patch.audience) caps.internal = patch.audience === 'staff';
  db.prepare("UPDATE share_links SET name = ?, caps = ?, audience = ?, stage = 'review', updated_at = ? WHERE id = ?")
    .run(patch.name?.trim() || current.name, JSON.stringify(caps), audience, new Date().toISOString(), id);
  if (patch.emails) {
    db.prepare('DELETE FROM share_link_emails WHERE share_id = ?').run(id);
    for (const email of normaliseEmails(patch.emails)) {
      db.prepare('INSERT OR IGNORE INTO share_link_emails (share_id, email) VALUES (?, ?)').run(id, email);
    }
  }
  return getShareLink(id);
}

/** Append videos to an ad-hoc share (skips ones already in it). */
export function addShareItems(shareId: string, items: Array<{ assetId: string; projectId: string; clientTitle?: string | null }>): void {
  const db = getShareLinksDb();
  const max = (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM share_link_items WHERE share_id = ? AND in_list = 1').get(shareId) as { m: number }).m;
  let pos = max + 1;
  for (const it of items) {
    upsertItemRow(db, shareId, it.assetId, it.projectId, { position: pos++, clientTitle: it.clientTitle ?? null, inList: true, onlyIfNew: true });
  }
  touch(db, shareId);
}

export function removeShareItem(shareId: string, assetId: string): void {
  const db = getShareLinksDb();
  db.prepare('UPDATE share_link_items SET in_list = 0 WHERE share_id = ? AND asset_id = ?').run(shareId, assetId);
  touch(db, shareId);
}

export function setShareItemTitle(shareId: string, assetId: string, clientTitle: string | null): void {
  const db = getShareLinksDb();
  db.prepare('UPDATE share_link_items SET client_title = ? WHERE share_id = ? AND asset_id = ?').run(clientTitle, shareId, assetId);
  touch(db, shareId);
}

/** Ensure per-video state exists (e.g. to mint a reshare token for a pass-backed video). */
export function ensureShareItemState(shareId: string, assetId: string, projectId: string): ShareLinkItem {
  const db = getShareLinksDb();
  upsertItemRow(db, shareId, assetId, projectId, { inList: false, onlyIfNew: true });
  return getShareItemState(shareId).get(assetId)!;
}

export function revokeShareLink(id: string): void {
  const now = new Date().toISOString();
  getShareLinksDb().prepare('UPDATE share_links SET revoked_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function touch(db: DatabaseSync, shareId: string): void {
  db.prepare('UPDATE share_links SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), shareId);
}

function normaliseEmails(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
}

function upsertItemRow(
  db: DatabaseSync, shareId: string, assetId: string, projectId: string,
  opts: { position?: number; clientTitle?: string | null; inList: boolean; onlyIfNew?: boolean },
): void {
  const existing = db.prepare('SELECT in_list FROM share_link_items WHERE share_id = ? AND asset_id = ?').get(shareId, assetId) as { in_list: number } | undefined;
  if (existing) {
    if (opts.inList && existing.in_list === 0) {
      db.prepare('UPDATE share_link_items SET in_list = 1, position = ? WHERE share_id = ? AND asset_id = ?').run(opts.position ?? 0, shareId, assetId);
    }
    if (opts.onlyIfNew) return;
    return;
  }
  const videoToken = newToken(db, 'SELECT 1 FROM share_link_items WHERE video_token = ?');
  db.prepare(
    `INSERT INTO share_link_items (share_id, asset_id, project_id, position, client_title, video_token, in_list)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(shareId, assetId, projectId, opts.position ?? 0, opts.clientTitle ?? null, videoToken, opts.inList ? 1 : 0);
}
