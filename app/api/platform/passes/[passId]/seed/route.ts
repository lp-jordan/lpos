import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getPassTree, createCategory, createTile, updateTile } from '@/lib/store/platform-pass-store';
import { readPassMapTab } from '@/lib/services/google-sheets-client';
import { seed } from '@/lib/platform/pass-map-projection';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

/**
 * POST — seed a categories+tiles skeleton from the connected pass-map tab.
 * Guarded to empty passes (pass `{ force: true }` to append onto a non-empty one).
 * Each seeded tile carries its J-Code (`source_code`) and sheet title (`title_source='sheet'`).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;

  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const tree = getPassTree(passId);
  if (!tree) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!tree.sheetId || !tree.sheetTabTitle) {
    return NextResponse.json({ error: 'Connect a pass map first.' }, { status: 400 });
  }
  if (tree.categories.length > 0 && !body.force) {
    return NextResponse.json({ error: 'This pass already has categories. Seeding is for empty passes.', needsForce: true }, { status: 409 });
  }

  let rows;
  try {
    ({ rows } = await readPassMapTab(tree.sheetId, tree.sheetTabTitle, tree.sheetTabGid));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to read pass map' }, { status: 422 });
  }

  const plan = seed(rows);
  let categoriesCreated = 0;
  let tilesCreated = 0;
  for (const cat of plan.categories) {
    const category = createCategory(passId, { title: cat.title });
    if (!category) continue;
    categoriesCreated++;
    for (const t of cat.tiles) {
      const tile = createTile(category.id, { title: t.title });
      if (!tile) continue;
      updateTile(tile.id, { sourceCode: t.code, titleSource: 'sheet' });
      tilesCreated++;
    }
  }

  return NextResponse.json({ ok: true, categoriesCreated, tilesCreated, pass: getPassTree(passId) });
}
