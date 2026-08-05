/**
 * Pass-map projection engine (pure, no IO).
 *
 * Two modes over the same match logic:
 *  - `reconcile(tree, rows)` — an existing pass: compare every tile to the sheet
 *    by J-Code, classify it, and propose sheet titles for the clean matches
 *    (never overwriting a human-set `title_source==='manual'`).
 *  - `seed(rows)` — an empty pass: turn the sheet's hierarchy into a
 *    categories+tiles plan (each tile seeded with `source_code` + sheet title).
 *
 * Description generation and transcript readiness are handled by the prep route
 * (they require IO/AI); this module only resolves titles and structure.
 */

import type { PassTree, PlatformTile, TileTitleSource } from '@/lib/store/platform-pass-store';
import type { PassMapRow } from '@/lib/services/google-sheets-client';
import { parseJCode } from '@/lib/passprep/jcode';

export type ReconcileState =
  | 'matched'            // code found in sheet, title applied/proposed
  | 'category_mismatch'  // code matched but the sheet places it in another category
  | 'no_code_on_asset'   // linked asset name has no parseable J-Code
  | 'code_not_in_sheet'  // parsed code absent from the map
  | 'no_asset_linked';   // tile has no linked video

export interface ReconcileRow {
  tileId: string;
  categoryId: string;
  tileCategory: string;
  tileTitle: string;
  code: string | null;
  state: ReconcileState;
  /** Title from the sheet for this code (null when unmatched). */
  sheetTitle: string | null;
  /** Category the sheet puts this code in (null when unmatched). */
  sheetCategory: string | null;
  titleSource: TileTitleSource | null;
  /** True when a sheet title will be written on run (clean/mismatch match and not manual). */
  willApplyTitle: boolean;
}

export interface TitleOp {
  tileId: string;
  title: string;
  sourceCode: string;
}

export interface ReconcileResult {
  mode: 'reconcile';
  report: ReconcileRow[];
  titleOps: TitleOp[];
  counts: Record<ReconcileState, number> & { willApplyTitle: number };
}

export interface SeedTile {
  title: string;
  code: string;
}
export interface SeedCategory {
  title: string;
  tiles: SeedTile[];
}
export interface SeedResult {
  mode: 'seed';
  categories: SeedCategory[];
  tileCount: number;
}

/** Normalize a category name for tolerant comparison (case/space/trailing colon). */
function normCategory(s: string): string {
  return (s ?? '').toLowerCase().replace(/[:\s]+/g, ' ').trim();
}

/** Resolve a tile's J-Code: stored source_code first, else parse the linked name. */
export function resolveTileCode(tile: Pick<PlatformTile, 'sourceCode' | 'mediaTitle'>): string | null {
  return tile.sourceCode ?? parseJCode(tile.mediaTitle ?? '');
}

/** Index sheet rows by normalized code (last write wins; codes are unique per tab). */
function indexRows(rows: PassMapRow[]): Map<string, PassMapRow> {
  const map = new Map<string, PassMapRow>();
  for (const row of rows) if (row.code) map.set(row.code.toUpperCase(), row);
  return map;
}

/**
 * Reconcile an existing pass tree against sheet rows. Produces a per-tile report
 * and the set of title writes to apply. Idempotent: re-running after applying
 * yields the same matched states and no further ops for already-applied tiles.
 */
export function reconcile(tree: PassTree, rows: PassMapRow[]): ReconcileResult {
  const byCode = indexRows(rows);
  const report: ReconcileRow[] = [];
  const titleOps: TitleOp[] = [];
  const counts = {
    matched: 0, category_mismatch: 0, no_code_on_asset: 0,
    code_not_in_sheet: 0, no_asset_linked: 0, willApplyTitle: 0,
  } as ReconcileResult['counts'];

  for (const category of tree.categories) {
    for (const tile of category.tiles) {
      const code = resolveTileCode(tile);
      const row = code ? byCode.get(code) ?? null : null;

      let state: ReconcileState;
      if (!tile.mediaAssetId) state = 'no_asset_linked';
      else if (!code) state = 'no_code_on_asset';
      else if (!row) state = 'code_not_in_sheet';
      else state = normCategory(row.category) === normCategory(category.title) ? 'matched' : 'category_mismatch';

      const sheetTitle = row?.title?.trim() || null;
      // Apply the sheet title on clean or mismatched matches, unless a human set it.
      const willApplyTitle =
        (state === 'matched' || state === 'category_mismatch') &&
        !!sheetTitle &&
        tile.titleSource !== 'manual' &&
        sheetTitle !== tile.title; // no-op if already equal (idempotent)

      report.push({
        tileId: tile.id,
        categoryId: category.id,
        tileCategory: category.title,
        tileTitle: tile.title,
        code,
        state,
        sheetTitle,
        sheetCategory: row?.category ?? null,
        titleSource: tile.titleSource,
        willApplyTitle,
      });
      counts[state]++;
      if (willApplyTitle && code && sheetTitle) {
        titleOps.push({ tileId: tile.id, title: sheetTitle, sourceCode: code });
        counts.willApplyTitle++;
      }
    }
  }

  return { mode: 'reconcile', report, titleOps, counts };
}

/**
 * Seed a categories+tiles plan from sheet rows (empty-pass path). Categories are
 * emitted in first-seen order; rows with no category fall under a synthetic
 * "Uncategorized". Every tile carries its code + sheet title.
 */
export function seed(rows: PassMapRow[]): SeedResult {
  const order: string[] = [];
  const byCategory = new Map<string, SeedTile[]>();

  for (const row of rows) {
    if (!row.code) continue;
    const category = row.category?.trim() || 'Uncategorized';
    if (!byCategory.has(category)) { byCategory.set(category, []); order.push(category); }
    byCategory.get(category)!.push({ title: row.title?.trim() || row.code, code: row.code.toUpperCase() });
  }

  const categories: SeedCategory[] = order.map((title) => ({ title, tiles: byCategory.get(title)! }));
  const tileCount = categories.reduce((n, c) => n + c.tiles.length, 0);
  return { mode: 'seed', categories, tileCount };
}

/** Convenience dispatcher matching the plan's `project(tree, rows, mode)` shape. */
export function project(tree: PassTree, rows: PassMapRow[], mode: 'reconcile'): ReconcileResult;
export function project(tree: PassTree | null, rows: PassMapRow[], mode: 'seed'): SeedResult;
export function project(tree: PassTree | null, rows: PassMapRow[], mode: 'reconcile' | 'seed'): ReconcileResult | SeedResult {
  return mode === 'seed' ? seed(rows) : reconcile(tree as PassTree, rows);
}
