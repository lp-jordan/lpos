import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, seed, resolveTileCode } from '../lib/platform/pass-map-projection';
import type { PassTree, PlatformTile } from '../lib/store/platform-pass-store';
import type { PassMapRow } from '../lib/services/google-sheets-client';

// ── factories ──
function tile(p: Partial<PlatformTile> & { id: string }): PlatformTile {
  return {
    id: p.id, categoryId: p.categoryId ?? 'c1', title: p.title ?? 'Untitled', description: '',
    position: 0, lpTileId: null, mediaAssetId: p.mediaAssetId ?? null, mediaProjectId: null,
    mediaKind: null, mediaTitle: p.mediaTitle ?? null, mediaThumbUrl: null, mediaVersion: null,
    linkUrl: null, sourceCode: p.sourceCode ?? null, titleSource: p.titleSource ?? null,
    descriptionSource: null, titleAssetId: null, descriptionAssetId: null,
    archetype: 'gradient', paletteIndex: 0, seed: 0, grain: 'subtle',
    imageMime: null, imageSource: null, imagePrompt: null, duoShadow: null, duoLight: null,
    backgroundRef: null, durationSec: null, createdAt: '', updatedAt: '',
  };
}
function treeOf(cats: Array<{ id: string; title: string; tiles: PlatformTile[] }>): PassTree {
  return {
    id: 'p1', title: 'Pass', slug: 'pass', source: 'local', lpPassId: null, status: 'draft',
    brand: 'leaderpass', brandConfig: null, defaultProjectId: null, sheetId: null, sheetUrl: null,
    sheetConnectedAt: null, sheetTabCount: null, sheetRowCount: null, sheetTabGid: null,
    sheetTabTitle: null, createdAt: '', updatedAt: '',
    categories: cats.map((c) => ({ id: c.id, passId: 'p1', title: c.title, position: 0, createdAt: '', tiles: c.tiles })),
  };
}
function row(code: string, category: string, title: string): PassMapRow {
  return { code, codeRaw: code, category, title, tab: 'Pass 1' };
}

const ROWS: PassMapRow[] = [
  row('A1', 'Introduction', 'What to expect'),
  row('A2', 'Introduction', 'How to engage'),
  row('B1', 'Context', 'The Need for Good Leaders'),
];

test('reconcile: clean match proposes + applies the sheet title', () => {
  const t = treeOf([{ id: 'c1', title: 'Introduction', tiles: [
    tile({ id: 't1', mediaAssetId: 'a1', mediaTitle: 'A1.mp4', title: 'placeholder' }),
  ] }]);
  const r = reconcile(t, ROWS);
  assert.equal(r.report[0].state, 'matched');
  assert.equal(r.report[0].code, 'A1');
  assert.equal(r.report[0].sheetTitle, 'What to expect');
  assert.equal(r.report[0].willApplyTitle, true);
  assert.deepEqual(r.titleOps, [{ tileId: 't1', title: 'What to expect', sourceCode: 'A1' }]);
});

test('reconcile: manual titles are never overwritten', () => {
  const t = treeOf([{ id: 'c1', title: 'Introduction', tiles: [
    tile({ id: 't1', mediaAssetId: 'a1', mediaTitle: 'A1.mp4', title: 'My hand title', titleSource: 'manual' }),
  ] }]);
  const r = reconcile(t, ROWS);
  assert.equal(r.report[0].state, 'matched');
  assert.equal(r.report[0].willApplyTitle, false);
  assert.equal(r.titleOps.length, 0);
});

test('reconcile: idempotent — already-equal title yields no op', () => {
  const t = treeOf([{ id: 'c1', title: 'Introduction', tiles: [
    tile({ id: 't1', mediaAssetId: 'a1', mediaTitle: 'A1.mp4', title: 'What to expect', titleSource: 'sheet' }),
  ] }]);
  const r = reconcile(t, ROWS);
  assert.equal(r.report[0].state, 'matched');
  assert.equal(r.report[0].willApplyTitle, false);
  assert.equal(r.titleOps.length, 0);
});

test('reconcile: category mismatch flagged but title still applied', () => {
  const t = treeOf([{ id: 'c9', title: 'Wrong Heading', tiles: [
    tile({ id: 't1', mediaAssetId: 'a1', mediaTitle: 'A1.mp4', title: 'x' }),
  ] }]);
  const r = reconcile(t, ROWS);
  assert.equal(r.report[0].state, 'category_mismatch');
  assert.equal(r.report[0].sheetCategory, 'Introduction');
  assert.equal(r.report[0].willApplyTitle, true);
  assert.equal(r.titleOps.length, 1);
});

test('reconcile: category compare tolerates case/space/colon', () => {
  const t = treeOf([{ id: 'c1', title: 'introduction ', tiles: [
    tile({ id: 't1', mediaAssetId: 'a1', mediaTitle: 'A1.mp4', title: 'x' }),
  ] }]);
  const r = reconcile(t, [row('A1', 'Introduction: ', 'What to expect')]);
  assert.equal(r.report[0].state, 'matched');
});

test('reconcile: the three unmatched states', () => {
  const t = treeOf([{ id: 'c1', title: 'Introduction', tiles: [
    tile({ id: 'noasset', title: 'empty' }),                                     // no_asset_linked
    tile({ id: 'nocode', mediaAssetId: 'a', mediaTitle: 'intro-final.mp4' }),    // no_code_on_asset
    tile({ id: 'notinsheet', mediaAssetId: 'a', mediaTitle: 'Z9.mp4' }),         // code_not_in_sheet
  ] }]);
  const r = reconcile(t, ROWS);
  const byId = Object.fromEntries(r.report.map((x) => [x.tileId, x.state]));
  assert.equal(byId.noasset, 'no_asset_linked');
  assert.equal(byId.nocode, 'no_code_on_asset');
  assert.equal(byId.notinsheet, 'code_not_in_sheet');
  assert.equal(r.titleOps.length, 0);
  assert.equal(r.counts.no_asset_linked, 1);
  assert.equal(r.counts.no_code_on_asset, 1);
  assert.equal(r.counts.code_not_in_sheet, 1);
});

test('reconcile: stored source_code wins over parsed name', () => {
  const t = treeOf([{ id: 'c1', title: 'Introduction', tiles: [
    tile({ id: 't1', mediaAssetId: 'a1', mediaTitle: 'friendly title no code.mp4', sourceCode: 'A2' }),
  ] }]);
  const r = reconcile(t, ROWS);
  assert.equal(r.report[0].code, 'A2');
  assert.equal(r.report[0].sheetTitle, 'How to engage');
});

test('seed: builds categories in first-seen order with coded tiles', () => {
  const s = seed(ROWS);
  assert.equal(s.mode, 'seed');
  assert.equal(s.tileCount, 3);
  assert.deepEqual(s.categories.map((c) => c.title), ['Introduction', 'Context']);
  assert.deepEqual(s.categories[0].tiles, [
    { title: 'What to expect', code: 'A1' },
    { title: 'How to engage', code: 'A2' },
  ]);
});

test('seed: missing category falls under Uncategorized; blank title falls back to code', () => {
  const s = seed([row('C1', '', ''), row('C2', '', 'Has title')]);
  assert.equal(s.categories[0].title, 'Uncategorized');
  assert.deepEqual(s.categories[0].tiles, [
    { title: 'C1', code: 'C1' },
    { title: 'Has title', code: 'C2' },
  ]);
});

test('resolveTileCode: source_code precedence then parse', () => {
  assert.equal(resolveTileCode({ sourceCode: 'H2', mediaTitle: 'A1.mp4' }), 'H2');
  assert.equal(resolveTileCode({ sourceCode: null, mediaTitle: 'A1.mp4' }), 'A1');
  assert.equal(resolveTileCode({ sourceCode: null, mediaTitle: null }), null);
});
