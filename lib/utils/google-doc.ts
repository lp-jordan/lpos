/**
 * Helpers for parsing Google Docs / Drive URLs.
 *
 * Person "Documents" store a living Google Doc URL. From that URL we derive:
 *   - the file id       → drives the Drive-thumbnail proxy + membership checks
 *   - the product kind  → document | spreadsheets | presentation | file
 *   - an export-PDF URL → the browser hits Google directly using the viewer's
 *                         own Google session (no service account needed)
 *
 * These are pure string transforms; nothing here touches the Drive API.
 */

export type GoogleDocKind = 'document' | 'spreadsheets' | 'presentation' | 'file';

export interface GoogleDocInfo {
  fileId:       string;
  kind:         GoogleDocKind;
  /** Direct PDF export the browser can open; null when the URL isn't a
   *  Google Workspace/Drive link we know how to export. */
  exportPdfUrl: string | null;
}

// Google file ids are long base64url-ish tokens. Match them after the common
// URL shapes: /d/<id>, /document/d/<id>, ?id=<id>, &id=<id>, open?id=<id>.
const ID_RE = /(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/;

const KIND_RE = /docs\.google\.com\/(document|spreadsheets|presentation)\//;

/** Extract just the Google file id, or null if the URL doesn't carry one. */
export function extractGoogleFileId(url: string): string | null {
  if (!url) return null;
  const m = ID_RE.exec(url);
  return m ? m[1] : null;
}

/** Full parse: id + kind + a browser-openable PDF export URL. */
export function parseGoogleDoc(url: string): GoogleDocInfo | null {
  const fileId = extractGoogleFileId(url);
  if (!fileId) return null;

  const kindMatch = KIND_RE.exec(url);
  const kind: GoogleDocKind = kindMatch ? (kindMatch[1] as GoogleDocKind) : 'file';

  // Workspace editors export via /<kind>/d/<id>/export?format=pdf.
  // Plain Drive files (kind = file) use the uc download endpoint instead.
  const exportPdfUrl = kind === 'file'
    ? `https://drive.google.com/uc?export=download&id=${fileId}`
    : `https://docs.google.com/${kind}/d/${fileId}/export?format=pdf`;

  return { fileId, kind, exportPdfUrl };
}
