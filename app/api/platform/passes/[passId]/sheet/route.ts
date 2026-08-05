import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { APP_SESSION_COOKIE, verifySessionToken } from '@/lib/services/session-auth';
import { getPass, setPassSheet, clearPassSheet } from '@/lib/store/platform-pass-store';
import {
  extractSpreadsheetId,
  listPassMapTabs,
  readPassMapTab,
  SheetsAccessError,
} from '@/lib/services/google-sheets-client';

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(APP_SESSION_COOKIE)?.value);
}

function handleSheetsError(err: unknown) {
  if (err instanceof SheetsAccessError) return NextResponse.json({ error: err.message }, { status: 422 });
  const message = err instanceof Error ? err.message : 'Failed to read sheet';
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * POST — two modes:
 *  1. `{ url }` only  → validate + enumerate tabs (the pick step; nothing persisted).
 *  2. `{ url, tabGid }` → connect: read that tab, persist the connection, return the read.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  if (!getPass(passId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { url?: string; tabGid?: number };
  const parsed = extractSpreadsheetId(body.url ?? '');
  if (!parsed) return NextResponse.json({ error: 'Could not find a spreadsheet id in that URL.' }, { status: 400 });

  try {
    const workbook = await listPassMapTabs(parsed.spreadsheetId);

    // Mode 1: no tab chosen yet → return the tab list for the picker.
    if (body.tabGid === undefined || body.tabGid === null) {
      return NextResponse.json({
        stage: 'pick-tab',
        spreadsheetId: workbook.spreadsheetId,
        spreadsheetTitle: workbook.spreadsheetTitle,
        tabs: workbook.tabs,
        suggestedGid: parsed.gid, // the gid from the pasted URL, if any
      });
    }

    // Mode 2: connect the chosen tab.
    const tab = workbook.tabs.find((t) => t.gid === body.tabGid);
    if (!tab) return NextResponse.json({ error: 'That tab is no longer in the workbook.' }, { status: 400 });

    const read = await readPassMapTab(workbook.spreadsheetId, tab.title, tab.gid);
    const pass = setPassSheet(passId, {
      sheetId: workbook.spreadsheetId,
      sheetUrl: body.url ?? '',
      tabGid: tab.gid,
      tabTitle: tab.title,
      tabCount: workbook.tabs.length,
      rowCount: read.rows.length,
    });

    return NextResponse.json({
      stage: 'connected',
      pass,
      read: {
        tab: read.tab,
        passName: read.passName,
        rowCount: read.rows.length,
        categoryCount: read.categoryCount,
        headerWarning: read.headerWarning,
        rows: read.rows,
      },
    });
  } catch (err) {
    return handleSheetsError(err);
  }
}

/** GET — re-read the connected tab fresh (used at prep run time; sheets drift). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  const pass = getPass(passId);
  if (!pass) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!pass.sheetId || !pass.sheetTabTitle) {
    return NextResponse.json({ error: 'No pass map connected.' }, { status: 400 });
  }
  try {
    const read = await readPassMapTab(pass.sheetId, pass.sheetTabTitle, pass.sheetTabGid);
    return NextResponse.json({
      read: {
        tab: read.tab,
        passName: read.passName,
        rowCount: read.rows.length,
        categoryCount: read.categoryCount,
        headerWarning: read.headerWarning,
        rows: read.rows,
      },
    });
  } catch (err) {
    return handleSheetsError(err);
  }
}

/** DELETE — disconnect the pass map. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ passId: string }> }) {
  if (!(await requireSession())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { passId } = await params;
  const pass = clearPassSheet(passId);
  if (!pass) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ pass });
}
