/**
 * Staging store for the Platform tab's pass composition (Pass → Category → Tile).
 *
 * Deliberately self-contained in its OWN SQLite file + module so the whole
 * section can later be lifted off LPOS (security) with the tab becoming a
 * link-out. LeaderPass admin remains the source of truth; the `lp_*_id`
 * columns bind a staging row to a real LP entity when connection lands.
 *
 * See docs/platform-passes.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deriveRecipe, DEFAULT_BRAND, type TileArchetype } from '@/lib/platform/tile-background';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'platform.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_platform_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS platform_passes (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'local',
      lp_pass_id  TEXT,
      status      TEXT NOT NULL DEFAULT 'draft',
      brand       TEXT NOT NULL DEFAULT 'leaderpass',
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_categories (
      id         TEXT PRIMARY KEY,
      pass_id    TEXT NOT NULL REFERENCES platform_passes(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_categories_pass ON platform_categories(pass_id);

    CREATE TABLE IF NOT EXISTS platform_tiles (
      id             TEXT PRIMARY KEY,
      category_id    TEXT NOT NULL REFERENCES platform_categories(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      position       INTEGER NOT NULL DEFAULT 0,
      lp_tile_id     TEXT,
      media_asset_id TEXT,
      media_kind     TEXT,
      link_url       TEXT,
      archetype      TEXT NOT NULL DEFAULT 'gradient',
      palette_index  INTEGER NOT NULL DEFAULT 0,
      seed           INTEGER NOT NULL DEFAULT 0,
      background_ref TEXT,
      duration_sec   INTEGER,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_tiles_category ON platform_tiles(category_id);
  `);
}

function getDb(): DatabaseSync {
  if (globalThis.__lpos_platform_db) return globalThis.__lpos_platform_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  globalThis.__lpos_platform_db = db;
  return db;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type PassSource = 'local' | 'leaderpass';
export type PassStatus = 'draft' | 'composed' | 'linked' | 'enriched' | 'exported' | 'synced';
export type TileMediaKind = 'video' | 'link' | 'pdf';

export interface PlatformPass {
  id: string;
  title: string;
  source: PassSource;
  lpPassId: string | null;
  status: PassStatus;
  brand: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformTile {
  id: string;
  categoryId: string;
  title: string;
  description: string;
  position: number;
  lpTileId: string | null;
  mediaAssetId: string | null;
  mediaKind: TileMediaKind | null;
  linkUrl: string | null;
  archetype: TileArchetype;
  paletteIndex: number;
  seed: number;
  backgroundRef: string | null;
  durationSec: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformCategory {
  id: string;
  passId: string;
  title: string;
  position: number;
  createdAt: string;
}

export interface PassTree extends PlatformPass {
  categories: Array<PlatformCategory & { tiles: PlatformTile[] }>;
}

// ── Row mappers ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function toPass(r: Row): PlatformPass {
  return {
    id: r.id as string,
    title: r.title as string,
    source: r.source as PassSource,
    lpPassId: (r.lp_pass_id as string) ?? null,
    status: r.status as PassStatus,
    brand: r.brand as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
function toCategory(r: Row): PlatformCategory {
  return {
    id: r.id as string,
    passId: r.pass_id as string,
    title: r.title as string,
    position: r.position as number,
    createdAt: r.created_at as string,
  };
}
function toTile(r: Row): PlatformTile {
  return {
    id: r.id as string,
    categoryId: r.category_id as string,
    title: r.title as string,
    description: r.description as string,
    position: r.position as number,
    lpTileId: (r.lp_tile_id as string) ?? null,
    mediaAssetId: (r.media_asset_id as string) ?? null,
    mediaKind: (r.media_kind as TileMediaKind) ?? null,
    linkUrl: (r.link_url as string) ?? null,
    archetype: r.archetype as TileArchetype,
    paletteIndex: r.palette_index as number,
    seed: r.seed as number,
    backgroundRef: (r.background_ref as string) ?? null,
    durationSec: (r.duration_sec as number) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ── Passes ───────────────────────────────────────────────────────────────────

export function listPasses(): PlatformPass[] {
  const rows = getDb().prepare('SELECT * FROM platform_passes ORDER BY updated_at DESC').all() as Row[];
  return rows.map(toPass);
}

export function createPass(input: { title: string; brand?: string; source?: PassSource; createdBy?: string }): PlatformPass {
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = input.title.trim() || 'Untitled pass';
  const brand = input.brand ?? DEFAULT_BRAND;
  const source = input.source ?? 'local';
  getDb().prepare(
    `INSERT INTO platform_passes (id, title, source, status, brand, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
  ).run(id, title, source, brand, input.createdBy ?? null, now, now);
  return { id, title, source, lpPassId: null, status: 'draft', brand, createdAt: now, updatedAt: now };
}

export function getPass(id: string): PlatformPass | null {
  const row = getDb().prepare('SELECT * FROM platform_passes WHERE id = ?').get(id) as Row | undefined;
  return row ? toPass(row) : null;
}

function touchPass(id: string): void {
  getDb().prepare('UPDATE platform_passes SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function updatePass(id: string, patch: { title?: string; status?: PassStatus; brand?: string }): PlatformPass | null {
  const existing = getPass(id);
  if (!existing) return null;
  const title = patch.title !== undefined ? patch.title.trim() || existing.title : existing.title;
  const status = patch.status ?? existing.status;
  const brand = patch.brand ?? existing.brand;
  getDb().prepare('UPDATE platform_passes SET title = ?, status = ?, brand = ?, updated_at = ? WHERE id = ?')
    .run(title, status, brand, new Date().toISOString(), id);
  return getPass(id);
}

export function deletePass(id: string): void {
  getDb().prepare('DELETE FROM platform_passes WHERE id = ?').run(id);
}

export function getPassTree(id: string): PassTree | null {
  const pass = getPass(id);
  if (!pass) return null;
  const cats = getDb().prepare('SELECT * FROM platform_categories WHERE pass_id = ? ORDER BY position, created_at').all(id) as Row[];
  const categories = cats.map((c) => {
    const category = toCategory(c);
    const tiles = getDb().prepare('SELECT * FROM platform_tiles WHERE category_id = ? ORDER BY position, created_at').all(category.id) as Row[];
    return { ...category, tiles: tiles.map(toTile) };
  });
  return { ...pass, categories };
}

// ── Categories ───────────────────────────────────────────────────────────────

function passIdForCategory(categoryId: string): string | null {
  const row = getDb().prepare('SELECT pass_id FROM platform_categories WHERE id = ?').get(categoryId) as Row | undefined;
  return row ? (row.pass_id as string) : null;
}

export function createCategory(passId: string, input: { title: string }): PlatformCategory | null {
  if (!getPass(passId)) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const max = getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM platform_categories WHERE pass_id = ?').get(passId) as Row;
  const position = (max.m as number) + 1;
  getDb().prepare('INSERT INTO platform_categories (id, pass_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, passId, input.title.trim() || 'New category', position, now);
  touchPass(passId);
  return { id, passId, title: input.title.trim() || 'New category', position, createdAt: now };
}

export function updateCategory(id: string, patch: { title?: string; position?: number }): void {
  const passId = passIdForCategory(id);
  if (!passId) return;
  if (patch.title !== undefined) {
    getDb().prepare('UPDATE platform_categories SET title = ? WHERE id = ?').run(patch.title.trim() || 'Category', id);
  }
  if (patch.position !== undefined) {
    getDb().prepare('UPDATE platform_categories SET position = ? WHERE id = ?').run(patch.position, id);
  }
  touchPass(passId);
}

export function deleteCategory(id: string): void {
  const passId = passIdForCategory(id);
  getDb().prepare('DELETE FROM platform_categories WHERE id = ?').run(id);
  if (passId) touchPass(passId);
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function context(categoryId: string): { passId: string; brand: string } | null {
  const row = getDb().prepare(
    `SELECT c.pass_id AS pass_id, p.brand AS brand
       FROM platform_categories c JOIN platform_passes p ON p.id = c.pass_id
      WHERE c.id = ?`,
  ).get(categoryId) as Row | undefined;
  return row ? { passId: row.pass_id as string, brand: row.brand as string } : null;
}

export function createTile(categoryId: string, input: { title: string; description?: string }): PlatformTile | null {
  const ctx = context(categoryId);
  if (!ctx) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = input.title.trim() || 'New tile';
  const description = (input.description ?? '').trim();
  const recipe = deriveRecipe(title, description, ctx.brand);
  const max = getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM platform_tiles WHERE category_id = ?').get(categoryId) as Row;
  const position = (max.m as number) + 1;
  getDb().prepare(
    `INSERT INTO platform_tiles
       (id, category_id, title, description, position, archetype, palette_index, seed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, categoryId, title, description, position, recipe.archetype, recipe.paletteIndex, recipe.seed, now, now);
  touchPass(ctx.passId);
  return getTile(id);
}

export function getTile(id: string): PlatformTile | null {
  const row = getDb().prepare('SELECT * FROM platform_tiles WHERE id = ?').get(id) as Row | undefined;
  return row ? toTile(row) : null;
}

function passIdForTile(tileId: string): string | null {
  const row = getDb().prepare(
    `SELECT c.pass_id AS pass_id FROM platform_tiles t JOIN platform_categories c ON c.id = t.category_id WHERE t.id = ?`,
  ).get(tileId) as Row | undefined;
  return row ? (row.pass_id as string) : null;
}

export interface TilePatch {
  title?: string;
  description?: string;
  archetype?: TileArchetype;
  paletteIndex?: number;
  seed?: number;
  position?: number;
}

export function updateTile(id: string, patch: TilePatch): PlatformTile | null {
  const existing = getTile(id);
  if (!existing) return null;
  const merged = {
    title: patch.title !== undefined ? (patch.title.trim() || existing.title) : existing.title,
    description: patch.description !== undefined ? patch.description : existing.description,
    archetype: patch.archetype ?? existing.archetype,
    paletteIndex: patch.paletteIndex ?? existing.paletteIndex,
    seed: patch.seed ?? existing.seed,
    position: patch.position ?? existing.position,
  };
  getDb().prepare(
    `UPDATE platform_tiles SET title = ?, description = ?, archetype = ?, palette_index = ?, seed = ?, position = ?, updated_at = ? WHERE id = ?`,
  ).run(merged.title, merged.description, merged.archetype, merged.paletteIndex, merged.seed, merged.position, new Date().toISOString(), id);
  const passId = passIdForTile(id);
  if (passId) touchPass(passId);
  return getTile(id);
}

/** Re-derive a tile's visual recipe from its (current) title + description. */
export function regenerateTile(id: string): PlatformTile | null {
  const tile = getTile(id);
  if (!tile) return null;
  const passId = passIdForTile(id);
  const brand = passId ? (getPass(passId)?.brand ?? DEFAULT_BRAND) : DEFAULT_BRAND;
  const recipe = deriveRecipe(tile.title, tile.description, brand);
  return updateTile(id, { archetype: recipe.archetype, paletteIndex: recipe.paletteIndex, seed: recipe.seed });
}

export function deleteTile(id: string): void {
  const passId = passIdForTile(id);
  getDb().prepare('DELETE FROM platform_tiles WHERE id = ?').run(id);
  if (passId) touchPass(passId);
}
