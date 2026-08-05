/**
 * Google Sheets client for Pass Prep "pass maps".
 *
 * Reuses the Drive service-account auth (scope `.../auth/drive` authorizes the
 * Sheets API — no new credential or scope). See `drive-client.ts#getGoogleAuth`.
 *
 * A pass map is a position-indented outline, one field per row by column:
 *   A = program title | B = `Pass:` name | C = `Category:` name
 *   D = `Video Title` | E = `J-CODE`     | F = `LP NOTES` (ignored)
 *
 * Tabs are Passes (one tab per Pass), so a platform pass connects to ONE tab.
 * `readPassMapTab` walks that tab top-to-bottom carrying the current Category
 * down onto each video row (a row with a J-CODE in col E).
 */

import { google, sheets_v4 } from 'googleapis';
import { getGoogleAuth } from './drive-client';
import { parseJCode } from '@/lib/passprep/jcode';

// Column indices in the pass-map template.
const COL = { PROGRAM: 0, PASS: 1, CATEGORY: 2, TITLE: 3, JCODE: 4, NOTES: 5 } as const;
const READ_ROW_CAP = 2000; // pass maps are tens of rows; cap defensively.

let _sheets: sheets_v4.Sheets | null = null;
function getSheetsClient(): sheets_v4.Sheets {
  if (_sheets) return _sheets;
  _sheets = google.sheets({ version: 'v4', auth: getGoogleAuth() });
  return _sheets;
}

export interface PassMapTab {
  title: string;
  gid: number;
  rowCount: number;
  colCount: number;
}

export interface PassMapWorkbook {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: PassMapTab[];
}

export interface PassMapRow {
  /** Normalized J-Code (upper-cased) used as the join key. */
  code: string;
  /** Raw cell text (for display/debug when normalization changes it). */
  codeRaw: string;
  category: string;
  title: string;
  tab: string;
}

export interface PassMapTabRead {
  tab: string;
  gid: number | null;
  passName: string | null;
  rows: PassMapRow[];
  categoryCount: number;
  /** Non-fatal: header didn't look like the standard template. */
  headerWarning: string | null;
}

export class SheetsAccessError extends Error {}

/**
 * Extract the spreadsheet id (and optional gid) from a pasted Google Sheets URL
 * or a bare id. Returns null when no id can be found.
 */
export function extractSpreadsheetId(input: string): { spreadsheetId: string; gid: number | null } | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Full URL: /spreadsheets/d/<id>/…
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = urlMatch ? urlMatch[1] : /^[a-zA-Z0-9-_]{20,}$/.test(trimmed) ? trimmed : null;
  if (!spreadsheetId) return null;
  const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);
  const gid = gidMatch ? Number(gidMatch[1]) : null;
  return { spreadsheetId, gid };
}

function wrapAccessError(err: unknown, spreadsheetId: string): never {
  const anyErr = err as { code?: number; message?: string };
  const status = anyErr?.code;
  if (status === 403) {
    throw new SheetsAccessError(
      `Can't access this sheet. Share it with the LPOS service account (Viewer is enough), or move it into the shared Team Drive. (id ${spreadsheetId})`,
    );
  }
  if (status === 404) {
    throw new SheetsAccessError(`Sheet not found — check the URL. (id ${spreadsheetId})`);
  }
  throw new SheetsAccessError(anyErr?.message ?? `Failed to read sheet ${spreadsheetId}`);
}

/** Enumerate a workbook's tabs (for the tab picker at connect time). */
export async function listPassMapTabs(spreadsheetId: string): Promise<PassMapWorkbook> {
  const sheets = getSheetsClient();
  let meta;
  try {
    meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties(title,sheetId,gridProperties(rowCount,columnCount))',
    });
  } catch (err) {
    wrapAccessError(err, spreadsheetId);
  }
  const tabs: PassMapTab[] = (meta.data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? '',
    gid: s.properties?.sheetId ?? 0,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    colCount: s.properties?.gridProperties?.columnCount ?? 0,
  }));
  return { spreadsheetId, spreadsheetTitle: meta.data.properties?.title ?? '', tabs };
}

/** A1-notation range for a whole tab's A:F, with the sheet name safely quoted. */
function tabRange(tabTitle: string, rowCount: number): string {
  const rows = Math.min(Math.max(rowCount || READ_ROW_CAP, 1), READ_ROW_CAP);
  const quoted = `'${tabTitle.replace(/'/g, "''")}'`;
  return `${quoted}!A1:F${rows}`;
}

const norm = (s: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fuzzy header sanity check against the template. Returns a warning or null. */
function checkHeader(header: string[]): string | null {
  const cat = norm(header[COL.CATEGORY] ?? '');
  const title = norm(header[COL.TITLE] ?? '');
  const jcode = norm(header[COL.JCODE] ?? '');
  const bad: string[] = [];
  if (!cat.startsWith('categor')) bad.push(`col C ("${header[COL.CATEGORY] ?? ''}") ≠ Category`);
  if (!(title.startsWith('video') || title.includes('title'))) bad.push(`col D ("${header[COL.TITLE] ?? ''}") ≠ Video Title`);
  if (!jcode.startsWith('jcod')) bad.push(`col E ("${header[COL.JCODE] ?? ''}") ≠ J-CODE`);
  return bad.length ? `This tab's header doesn't match the standard pass-map template: ${bad.join('; ')}. Parsed by column position anyway.` : null;
}

/**
 * Read ONE tab of a pass map into ordered PassMapRow[], resolving the indented
 * hierarchy (Category carries down onto subsequent video rows).
 */
export async function readPassMapTab(spreadsheetId: string, tabTitle: string, gid: number | null = null): Promise<PassMapTabRead> {
  const sheets = getSheetsClient();

  // Look up the tab's declared row count so the read range is bounded sensibly.
  const workbook = await listPassMapTabs(spreadsheetId);
  const tabMeta = workbook.tabs.find((t) => t.title === tabTitle) ?? workbook.tabs.find((t) => t.gid === gid);
  if (!tabMeta) {
    throw new SheetsAccessError(`Tab "${tabTitle}" not found in this workbook.`);
  }

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: tabRange(tabMeta.title, tabMeta.rowCount),
      majorDimension: 'ROWS',
    });
  } catch (err) {
    wrapAccessError(err, spreadsheetId);
  }

  const values = (res.data.values ?? []) as string[][];
  const header = (values[0] ?? []).map((c) => String(c ?? ''));
  const headerWarning = checkHeader(header);

  const cell = (row: string[], i: number): string => String(row?.[i] ?? '').trim();

  let passName: string | null = null;
  let currentCategory = '';
  const rows: PassMapRow[] = [];
  const categories = new Set<string>();

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row || row.length === 0) continue;
    const passCell = cell(row, COL.PASS);
    const categoryCell = cell(row, COL.CATEGORY);
    const jcodeCell = cell(row, COL.JCODE);
    const titleCell = cell(row, COL.TITLE);

    if (passCell && !passName) passName = passCell;
    if (categoryCell) { currentCategory = categoryCell; categories.add(currentCategory); }

    // A video row is one that carries a J-CODE. Normalize the sheet code with
    // the SAME parser used on asset names so suffixed cells (e.g. "D1_2") and
    // suffixed filenames collapse to the same key ("D1") and join symmetrically.
    if (jcodeCell) {
      const code = parseJCode(jcodeCell) ?? jcodeCell.toUpperCase();
      rows.push({ code, codeRaw: jcodeCell, category: currentCategory, title: titleCell, tab: tabMeta.title });
    }
  }

  return {
    tab: tabMeta.title,
    gid: tabMeta.gid,
    passName,
    rows,
    categoryCount: categories.size,
    headerWarning,
  };
}
