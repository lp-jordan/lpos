/**
 * J-Code parsing — the shared join key between assets, the pass-map sheet, and
 * platform tiles.
 *
 * A J-Code is a shoot identifier of the form `<digits><single letter>` (e.g.
 * `1A`, `2A`, `12B`) that appears as the asset filename (verified in prod: e.g.
 * `1A.mp4`). It is matched to a pass-map sheet row and persisted on the tile as
 * `source_code`.
 *
 * Extracted and hardened from `core.ts`'s original inline regex
 * (`/\b\d+[a-z]\b/i` in `deriveSourceFromVideoName`). Hardening over the
 * original:
 *  - Separators (`.`, `_`, `-`, spaces, parens, …) are all normalized to spaces
 *    first, so underscore-delimited codes like `Session_5D_master` resolve
 *    (a bare `\b` treats `_` as a word char and would miss them).
 *  - The digit run is bounded to 1–2, which rejects resolution/codec tokens
 *    like `720p` / `1080p` / `h264` while still accepting real codes up to `99Z`.
 *  - The code is always returned upper-cased.
 */

// 1–2 digits + exactly one trailing letter, as a whole token (\b guards both ends).
const J_CODE_RE = /\b(\d{1,2}[a-z])\b/i;

/**
 * Parse the J-Code out of an asset/video name. Returns the normalized
 * (upper-cased) code, or `null` when the name carries no parseable code.
 *
 * Examples: `"1A.mp4" → "1A"`, `"  2a "` → `"2A"`, `"Session_5D_master.mp4"` →
 * `"5D"`, `"Day 1 - 3B final.mov"` → `"3B"` (first token wins),
 * `"intro.mp4"` → `null`, `"render_h264.mp4"` → `null`.
 */
export function parseJCode(name: string | null | undefined): string | null {
  if (!name) return null;
  // Collapse every non-alphanumeric separator (incl. the extension dot) to a
  // space so codes bounded by `_`, `-`, `.` or spaces all tokenize the same way.
  const normalized = String(name).replace(/[^a-z0-9]+/gi, ' ').trim();
  const match = normalized.match(J_CODE_RE);
  return match ? match[1].toUpperCase() : null;
}

/** True when `name` contains a parseable J-Code. */
export function hasJCode(name: string | null | undefined): boolean {
  return parseJCode(name) !== null;
}

/** Normalize an already-known code string for comparison (upper/trim). Returns
 *  null if it isn't a valid standalone code — used when reading codes from the
 *  sheet, where a cell should already be a bare code. */
export function normalizeJCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = String(code).trim();
  return /^\d{1,2}[a-z]$/i.test(trimmed) ? trimmed.toUpperCase() : null;
}
