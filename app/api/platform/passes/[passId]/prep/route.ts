import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getPassTree, getTile, updateTile } from '@/lib/store/platform-pass-store';
import { getAsset } from '@/lib/store/media-registry';
import { readPassMapTab } from '@/lib/services/google-sheets-client';
import { reconcile, resolveTileCode, type ReconcileRow } from '@/lib/platform/pass-map-projection';
import { getTranscriptTextByAsset } from '@/lib/transcripts/store';
import { parseJCode } from '@/lib/passprep/jcode';
import { inferAiProvider } from '@/lib/passprep/core';
import { generateTitleFromTranscript, generateDescriptionFromTranscript } from '@/lib/passprep/generate-fields';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

type TranscriptState = 'ready' | 'missing' | 'no_asset';
type TitleOutcome = 'sheet' | 'ai' | 'kept' | 'unresolved';
type DescriptionOutcome = 'generated' | 'kept' | 'manual' | 'no_transcript' | 'error';

interface PrepReportRow {
  tileId: string;
  categoryId: string;
  tileCategory: string;
  code: string | null;
  state: ReconcileRow['state'];
  transcript: TranscriptState;
  titleBefore: string;
  titleAfter: string;
  titleOutcome: TitleOutcome;
  descriptionOutcome: DescriptionOutcome;
  error: string | null;
}

/** A title is safe for AI to (re)write: placeholder, code-echo, or already AI. */
function isReplaceableTitle(title: string, code: string | null, source: string | null): boolean {
  if (source === 'ai') return true;
  const t = (title ?? '').trim().toLowerCase();
  if (!t || t === 'new tile' || t === 'untitled') return true;
  if (code && t === code.toLowerCase()) return true;
  return false;
}

/** Run async tasks with a small concurrency cap (keeps N AI calls in flight). */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;

  const body = (await req.json().catch(() => ({}))) as { regenerateDescriptions?: boolean; generateTitles?: boolean };
  const regenerateDescriptions = body.regenerateDescriptions ?? false;
  const generateTitles = body.generateTitles ?? true;

  let tree = getPassTree(passId);
  if (!tree) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // ── 1. Enrich source_code from the real asset filename (robust to display-name renames).
  for (const cat of tree.categories) {
    for (const tile of cat.tiles) {
      if (tile.sourceCode || !tile.mediaAssetId || !tile.mediaProjectId) continue;
      const asset = getAsset(tile.mediaProjectId, tile.mediaAssetId);
      const code = parseJCode(asset?.originalFilename ?? '') ?? parseJCode(asset?.name ?? '') ?? parseJCode(tile.mediaTitle ?? '');
      if (code) updateTile(tile.id, { sourceCode: code });
    }
  }
  // Reload so reconcile sees the stamped codes.
  tree = getPassTree(passId)!;

  // ── 2. Fresh sheet rows (if a pass map is connected).
  let sheetConnected = false;
  let sheetError: string | null = null;
  let rows: Awaited<ReturnType<typeof readPassMapTab>>['rows'] = [];
  if (tree.sheetId && tree.sheetTabTitle) {
    try {
      const read = await readPassMapTab(tree.sheetId, tree.sheetTabTitle, tree.sheetTabGid);
      rows = read.rows;
      sheetConnected = true;
    } catch (err) {
      sheetError = err instanceof Error ? err.message : 'Failed to read pass map';
    }
  }

  // ── 3. Reconcile + apply sheet titles synchronously (deterministic, fast).
  const recon = reconcile(tree, rows);
  const rowByTile = new Map(recon.report.map((r) => [r.tileId, r]));
  for (const op of recon.titleOps) {
    updateTile(op.tileId, { title: op.title, titleSource: 'sheet', sourceCode: op.sourceCode });
  }

  // ── 4. AI pass: titles for unmatched/placeholder tiles + descriptions from transcript.
  const provider = inferAiProvider();
  const report: PrepReportRow[] = [];
  const workItems: Array<{ catId: string; catTitle: string; tileId: string }> = [];
  for (const cat of tree.categories) for (const tile of cat.tiles) {
    workItems.push({ catId: cat.id, catTitle: cat.title, tileId: tile.id });
  }

  await pool(workItems, 5, async ({ catId, catTitle, tileId }) => {
    const fresh = getTile(tileId); // reflects the sheet-title write above
    if (!fresh) return;
    const rr = rowByTile.get(tileId);
    const code = resolveTileCode(fresh);
    const appliedSheet = recon.titleOps.some((o) => o.tileId === tileId);

    let transcript: TranscriptState = 'no_asset';
    let titleAfter = fresh.title;
    let titleOutcome: TitleOutcome = appliedSheet ? 'sheet' : 'kept';
    let descriptionOutcome: DescriptionOutcome = 'no_transcript';
    let error: string | null = null;

    if (fresh.mediaAssetId && fresh.mediaProjectId) {
      const tr = getTranscriptTextByAsset(fresh.mediaProjectId, fresh.mediaAssetId);
      transcript = tr ? 'ready' : 'missing';

      if (tr && provider) {
        // AI title fallback — only when no sheet title landed and the title is safe to replace.
        if (generateTitles && !appliedSheet && fresh.titleSource !== 'manual' && isReplaceableTitle(fresh.title, code, fresh.titleSource)) {
          try {
            const aiTitle = await generateTitleFromTranscript({ transcript: tr.text, code });
            updateTile(tileId, { title: aiTitle, titleSource: 'ai', sourceCode: code ?? undefined });
            titleAfter = aiTitle;
            titleOutcome = 'ai';
          } catch (e) { error = (e as Error).message; }
        }
        // Description — always AI from transcript, unless human-authored; regenerate only on request.
        if (fresh.descriptionSource === 'manual') {
          descriptionOutcome = 'manual';
        } else if (fresh.description && !regenerateDescriptions) {
          descriptionOutcome = 'kept';
        } else {
          try {
            const desc = await generateDescriptionFromTranscript({ transcript: tr.text, title: titleAfter });
            updateTile(tileId, { description: desc, descriptionSource: 'ai' });
            descriptionOutcome = 'generated';
          } catch (e) { error = error ?? (e as Error).message; }
        }
      }
    }

    if (!appliedSheet && titleOutcome !== 'ai') titleOutcome = code && rr?.state === 'matched' ? 'kept' : 'unresolved';

    report.push({
      tileId, categoryId: catId, tileCategory: catTitle, code,
      state: rr?.state ?? 'no_asset_linked',
      transcript, titleBefore: fresh.title, titleAfter,
      titleOutcome, descriptionOutcome, error,
    });
  });

  // Stable order: by category then tile position (report was filled out of order by the pool).
  const order = new Map<string, number>();
  let n = 0;
  for (const cat of tree.categories) for (const tile of cat.tiles) order.set(tile.id, n++);
  report.sort((a, b) => (order.get(a.tileId) ?? 0) - (order.get(b.tileId) ?? 0));

  return NextResponse.json({
    ok: true,
    sheetConnected,
    sheetError,
    aiAvailable: !!provider,
    counts: {
      ...recon.counts,
      titlesFromSheet: recon.titleOps.length,
      titlesFromAi: report.filter((r) => r.titleOutcome === 'ai').length,
      descriptionsGenerated: report.filter((r) => r.descriptionOutcome === 'generated').length,
      noTranscript: report.filter((r) => r.transcript === 'missing').length,
    },
    report,
  });
}
