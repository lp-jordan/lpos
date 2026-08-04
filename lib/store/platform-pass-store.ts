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
import {
  deriveRecipe, resolveBrand, hashStr, DEFAULT_BRAND,
  type TileArchetype, type BrandConfig, type GrainLevel,
} from '@/lib/platform/tile-background';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'platform.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_platform_db: DatabaseSync | undefined;
}

type Row = Record<string, unknown>;

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS platform_passes (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      slug         TEXT,
      source       TEXT NOT NULL DEFAULT 'local',
      lp_pass_id   TEXT,
      status       TEXT NOT NULL DEFAULT 'draft',
      brand        TEXT NOT NULL DEFAULT 'leaderpass',
      brand_config TEXT,
      default_project_id TEXT,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
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
      media_asset_id   TEXT,
      media_project_id TEXT,
      media_kind     TEXT,
      media_title    TEXT,
      media_thumb_url TEXT,
      media_version  INTEGER,
      link_url       TEXT,
      archetype      TEXT NOT NULL DEFAULT 'gradient',
      palette_index  INTEGER NOT NULL DEFAULT 0,
      seed           INTEGER NOT NULL DEFAULT 0,
      grain          TEXT NOT NULL DEFAULT 'subtle',
      image_mime     TEXT,
      duo_shadow     TEXT,
      duo_light      TEXT,
      background_ref TEXT,
      duration_sec   INTEGER,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_tiles_category ON platform_tiles(category_id);

    CREATE TABLE IF NOT EXISTS platform_brand_presets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);
  // Migrations for DBs created before these columns existed.
  ensureColumn(db, 'platform_passes', 'slug', `slug TEXT`);
  ensureColumn(db, 'platform_passes', 'brand_config', `brand_config TEXT`);
  ensureColumn(db, 'platform_passes', 'default_project_id', `default_project_id TEXT`);
  ensureColumn(db, 'platform_tiles', 'grain', `grain TEXT NOT NULL DEFAULT 'subtle'`);
  ensureColumn(db, 'platform_tiles', 'media_project_id', `media_project_id TEXT`);
  ensureColumn(db, 'platform_tiles', 'media_title', `media_title TEXT`);
  ensureColumn(db, 'platform_tiles', 'media_thumb_url', `media_thumb_url TEXT`);
  ensureColumn(db, 'platform_tiles', 'image_mime', `image_mime TEXT`);
  ensureColumn(db, 'platform_tiles', 'media_version', `media_version INTEGER`);
  ensureColumn(db, 'platform_tiles', 'duo_shadow', `duo_shadow TEXT`);
  ensureColumn(db, 'platform_tiles', 'duo_light', `duo_light TEXT`);
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
  slug: string;
  source: PassSource;
  lpPassId: string | null;
  status: PassStatus;
  brand: string;
  brandConfig: BrandConfig | null;
  defaultProjectId: string | null;
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
  mediaProjectId: string | null;
  mediaKind: TileMediaKind | null;
  mediaTitle: string | null;
  mediaThumbUrl: string | null;
  mediaVersion: number | null;
  linkUrl: string | null;
  archetype: TileArchetype;
  paletteIndex: number;
  seed: number;
  grain: GrainLevel;
  imageMime: string | null;
  duoShadow: string | null;
  duoLight: string | null;
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

function parseBrandConfig(raw: unknown): BrandConfig | null {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw) as BrandConfig; } catch { return null; }
}

function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'pass';
}

/** A slug unique among passes (appends -2, -3, … on collision). */
function uniqueSlug(base: string, excludeId?: string): string {
  const rows = getDb().prepare('SELECT id, slug FROM platform_passes').all() as Row[];
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.slug as string));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) { const c = `${base}-${i}`; if (!taken.has(c)) return c; }
  return `${base}-${excludeId ?? Math.floor(Math.random())}`;
}

function toPass(r: Row): PlatformPass {
  return {
    id: r.id as string,
    title: r.title as string,
    slug: (r.slug as string) || slugify(r.title as string),
    source: r.source as PassSource,
    lpPassId: (r.lp_pass_id as string) ?? null,
    status: r.status as PassStatus,
    brand: r.brand as string,
    brandConfig: parseBrandConfig(r.brand_config),
    defaultProjectId: (r.default_project_id as string) ?? null,
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
    mediaProjectId: (r.media_project_id as string) ?? null,
    mediaKind: (r.media_kind as TileMediaKind) ?? null,
    mediaTitle: (r.media_title as string) ?? null,
    mediaThumbUrl: (r.media_thumb_url as string) ?? null,
    mediaVersion: (r.media_version as number) ?? null,
    linkUrl: (r.link_url as string) ?? null,
    archetype: r.archetype as TileArchetype,
    paletteIndex: r.palette_index as number,
    seed: r.seed as number,
    grain: (r.grain as GrainLevel) ?? 'subtle',
    imageMime: (r.image_mime as string) ?? null,
    duoShadow: (r.duo_shadow as string) ?? null,
    duoLight: (r.duo_light as string) ?? null,
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
  const slug = uniqueSlug(slugify(title));
  getDb().prepare(
    `INSERT INTO platform_passes (id, title, slug, source, status, brand, brand_config, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, NULL, ?, ?, ?)`,
  ).run(id, title, slug, source, brand, input.createdBy ?? null, now, now);
  return { id, title, slug, source, lpPassId: null, status: 'draft', brand, brandConfig: null, defaultProjectId: null, createdAt: now, updatedAt: now };
}

export function getPass(id: string): PlatformPass | null {
  const row = getDb().prepare('SELECT * FROM platform_passes WHERE id = ?').get(id) as Row | undefined;
  return row ? toPass(row) : null;
}

export function getPassBySlug(slug: string): PlatformPass | null {
  const row = getDb().prepare('SELECT * FROM platform_passes WHERE slug = ?').get(slug) as Row | undefined;
  return row ? toPass(row) : null;
}

function touchPass(id: string): void {
  getDb().prepare('UPDATE platform_passes SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export interface PassPatch {
  title?: string;
  status?: PassStatus;
  brand?: string;
  brandConfig?: BrandConfig | null;
}

export function updatePass(id: string, patch: PassPatch): PlatformPass | null {
  const existing = getPass(id);
  if (!existing) return null;
  const title = patch.title !== undefined ? patch.title.trim() || existing.title : existing.title;
  const slug = title !== existing.title ? uniqueSlug(slugify(title), id) : existing.slug;
  const status = patch.status ?? existing.status;
  const brand = patch.brand ?? existing.brand;
  const brandConfig = 'brandConfig' in patch ? patch.brandConfig : existing.brandConfig;
  getDb().prepare('UPDATE platform_passes SET title = ?, slug = ?, status = ?, brand = ?, brand_config = ?, updated_at = ? WHERE id = ?')
    .run(title, slug, status, brand, brandConfig ? JSON.stringify(brandConfig) : null, new Date().toISOString(), id);
  return getPass(id);
}

export function deletePass(id: string): void {
  getDb().prepare('DELETE FROM platform_passes WHERE id = ?').run(id);
}

export function getPassTree(idOrSlug: string): PassTree | null {
  const pass = getPass(idOrSlug) ?? getPassBySlug(idOrSlug);
  if (!pass) return null;
  const cats = getDb().prepare('SELECT * FROM platform_categories WHERE pass_id = ? ORDER BY position, created_at').all(pass.id) as Row[];
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
  const title = input.title.trim() || 'New category';
  const max = getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM platform_categories WHERE pass_id = ?').get(passId) as Row;
  const position = (max.m as number) + 1;
  getDb().prepare('INSERT INTO platform_categories (id, pass_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, passId, title, position, now);
  touchPass(passId);
  return { id, passId, title, position, createdAt: now };
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

/** Persist a full category ordering for a pass (positions by array index). */
export function reorderCategories(passId: string, orderedIds: string[]): void {
  const db = getDb();
  orderedIds.forEach((cid, i) => db.prepare('UPDATE platform_categories SET position = ? WHERE id = ? AND pass_id = ?').run(i, cid, passId));
  touchPass(passId);
}

export function deleteCategory(id: string): void {
  const passId = passIdForCategory(id);
  getDb().prepare('DELETE FROM platform_categories WHERE id = ?').run(id);
  if (passId) touchPass(passId);
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function context(categoryId: string): { passId: string; brand: string; brandConfig: BrandConfig | null } | null {
  const row = getDb().prepare(
    `SELECT c.pass_id AS pass_id, p.brand AS brand, p.brand_config AS brand_config
       FROM platform_categories c JOIN platform_passes p ON p.id = c.pass_id
      WHERE c.id = ?`,
  ).get(categoryId) as Row | undefined;
  return row ? { passId: row.pass_id as string, brand: row.brand as string, brandConfig: parseBrandConfig(row.brand_config) } : null;
}

const NEW_TILE_ROTATION: TileArchetype[] = ['gradient', 'geometric', 'duotone'];

export function createTile(categoryId: string, input: { title: string; description?: string }): PlatformTile | null {
  const ctx = context(categoryId);
  if (!ctx) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const title = input.title.trim() || 'New tile';
  const description = (input.description ?? '').trim();
  const brand = resolveBrand(ctx.brand, ctx.brandConfig);
  const recipe = deriveRecipe(title, description, brand);
  const max = getDb().prepare('SELECT COALESCE(MAX(position), -1) AS m FROM platform_tiles WHERE category_id = ?').get(categoryId) as Row;
  const position = (max.m as number) + 1;

  // Vary each new tile from the preceding one AND across categories, so no two
  // rails come out in the same order. The per-category hash offsets the rotation,
  // palette, and seed so every category cycles differently.
  const catHash = hashStr(categoryId);
  const isGeneric = /^new tile$/i.test(title) || title === '';
  const archetype = isGeneric ? NEW_TILE_ROTATION[(position + catHash) % NEW_TILE_ROTATION.length] : recipe.archetype;
  const paletteIndex = (recipe.paletteIndex + position + catHash) % brand.accents.length;
  const seed = (recipe.seed ^ Math.imul(position + 1, 2654435761) ^ Math.imul(catHash + 1, 40503)) >>> 0;

  getDb().prepare(
    `INSERT INTO platform_tiles
       (id, category_id, title, description, position, archetype, palette_index, seed, grain, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'subtle', ?, ?)`,
  ).run(id, categoryId, title, description, position, archetype, paletteIndex, seed, now, now);
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
  grain?: GrainLevel;
  duoShadow?: string | null;
  duoLight?: string | null;
  position?: number;
  categoryId?: string;
}

export function updateTile(id: string, patch: TilePatch): PlatformTile | null {
  const existing = getTile(id);
  if (!existing) return null;
  const m = {
    title: patch.title !== undefined ? (patch.title.trim() || existing.title) : existing.title,
    description: patch.description !== undefined ? patch.description : existing.description,
    archetype: patch.archetype ?? existing.archetype,
    paletteIndex: patch.paletteIndex ?? existing.paletteIndex,
    seed: patch.seed ?? existing.seed,
    grain: patch.grain ?? existing.grain,
    duoShadow: 'duoShadow' in patch ? patch.duoShadow ?? null : existing.duoShadow,
    duoLight: 'duoLight' in patch ? patch.duoLight ?? null : existing.duoLight,
    position: patch.position ?? existing.position,
    categoryId: patch.categoryId ?? existing.categoryId,
  };
  getDb().prepare(
    `UPDATE platform_tiles SET title = ?, description = ?, archetype = ?, palette_index = ?, seed = ?, grain = ?, duo_shadow = ?, duo_light = ?, position = ?, category_id = ?, updated_at = ? WHERE id = ?`,
  ).run(m.title, m.description, m.archetype, m.paletteIndex, m.seed, m.grain, m.duoShadow, m.duoLight, m.position, m.categoryId, new Date().toISOString(), id);
  const passId = passIdForTile(id);
  if (passId) touchPass(passId);
  return getTile(id);
}

/** Persist a full tile ordering for a category (positions by array index). */
export function reorderTiles(categoryId: string, orderedIds: string[]): void {
  const db = getDb();
  orderedIds.forEach((tid, i) => db.prepare('UPDATE platform_tiles SET category_id = ?, position = ? WHERE id = ?').run(categoryId, i, tid));
  const passId = passIdForCategory(categoryId);
  if (passId) touchPass(passId);
}

/** Re-derive a tile's visual recipe from its (current) title + description. */
export function regenerateTile(id: string): PlatformTile | null {
  const tile = getTile(id);
  if (!tile) return null;
  const passId = passIdForTile(id);
  const pass = passId ? getPass(passId) : null;
  const brand = resolveBrand(pass?.brand ?? DEFAULT_BRAND, pass?.brandConfig ?? null);
  const recipe = deriveRecipe(tile.title, tile.description, brand);
  return updateTile(id, { archetype: recipe.archetype, paletteIndex: recipe.paletteIndex, seed: recipe.seed });
}

export function deleteTile(id: string): void {
  const passId = passIdForTile(id);
  getDb().prepare('DELETE FROM platform_tiles WHERE id = ?').run(id);
  if (passId) touchPass(passId);
}

// ── User-defined brand presets ───────────────────────────────────────────────

export interface BrandPreset { id: string; name: string; config: BrandConfig }

export function listBrandPresets(): BrandPreset[] {
  const rows = getDb().prepare('SELECT * FROM platform_brand_presets ORDER BY created_at').all() as Row[];
  return rows.map((r) => {
    let config: BrandConfig = {};
    try { config = JSON.parse(r.config_json as string) as BrandConfig; } catch { /* ignore */ }
    return { id: r.id as string, name: r.name as string, config };
  });
}

export function createBrandPreset(name: string, config: BrandConfig): BrandPreset {
  const id = randomUUID();
  const clean = name.trim() || 'Preset';
  getDb().prepare('INSERT INTO platform_brand_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
    .run(id, clean, JSON.stringify(config), new Date().toISOString());
  return { id, name: clean, config };
}

export function deleteBrandPreset(id: string): void {
  getDb().prepare('DELETE FROM platform_brand_presets WHERE id = ?').run(id);
}

// ── Media linking (Phase 2) ──────────────────────────────────────────────────

export interface TileMediaInput {
  kind: TileMediaKind;
  mediaAssetId?: string | null;
  mediaProjectId?: string | null;
  linkUrl?: string | null;
  title?: string | null;
  durationSec?: number | null;
  thumbUrl?: string | null;
  version?: number | null;
}

/** Remember the project a tile's media came from as the pass's default, so the
 *  media picker opens there next time (most tiles use the same project). */
export function rememberProjectForTile(tileId: string, projectId: string): void {
  const passId = passIdForTile(tileId);
  if (passId) getDb().prepare('UPDATE platform_passes SET default_project_id = ? WHERE id = ?').run(projectId, passId);
}

/** Set (or clear) the duotone source-image mime on a tile. The image bytes are
 *  stored on local disk by the image route; here we only track presence + mime. */
export function setTileImageMime(id: string, mime: string | null): PlatformTile | null {
  const existing = getTile(id);
  if (!existing) return null;
  getDb().prepare('UPDATE platform_tiles SET image_mime = ?, updated_at = ? WHERE id = ?')
    .run(mime, new Date().toISOString(), id);
  const passId = passIdForTile(id);
  if (passId) touchPass(passId);
  return getTile(id);
}

/** Attach (or, with `null`, detach) media on a tile. Media is a *reference* to a
 *  project-owned asset — LPOS never copies the media itself. */
export function setTileMedia(id: string, media: TileMediaInput | null): PlatformTile | null {
  const existing = getTile(id);
  if (!existing) return null;
  getDb().prepare(
    `UPDATE platform_tiles
        SET media_kind = ?, media_asset_id = ?, media_project_id = ?, media_title = ?,
            media_thumb_url = ?, media_version = ?, link_url = ?, duration_sec = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    media ? media.kind : null,
    media?.mediaAssetId ?? null,
    media?.mediaProjectId ?? null,
    media?.title ?? null,
    media?.thumbUrl ?? null,
    media?.version ?? null,
    media?.linkUrl ?? null,
    media?.durationSec ?? null,
    new Date().toISOString(),
    id,
  );
  const passId = passIdForTile(id);
  if (passId) touchPass(passId);
  return getTile(id);
}
