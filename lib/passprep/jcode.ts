/**
 * J-Code parsing — the shared join key between assets, the pass-map sheet, and
 * platform tiles.
 *
 * A J-Code identifies a lesson video. The dominant, current convention is
 * **letter-then-digit** (`A1`, `A2`, `B1`, `E1`, `H2`, `M8`, `Z1`) — verified
 * against both real asset filenames (`A1.mp4`, `A2_KH.mp4`, `M1_1.mp4`) and a
 * real pass-map sheet (J-CODE column values `A1`, `E1`, `H1`, `P1`, `V1`, `Z1`).
 * A minority of older assets use the reversed **digit-then-letter** form
 * (`1A.mp4`). We parse both orderings and return the code verbatim (upper-cased);
 * we do NOT cross-reverse — a client's assets and sheet are assumed to share one
 * ordering, so exact match after upper-casing is the correct join.
 *
 * Extracted and hardened from `core.ts`'s original inline regex
 * (`/\b\d+[a-z]\b/i`, which only handled digit-then-letter). Hardening:
 *  - Strip a trailing file extension first, so `A1.mp4` → `A1` and the `.mp4`
 *    tail can't be misread as the letter-major code `P4`.
 *  - Normalize every remaining separator (`_`, `-`, `.`, parens, spaces) to a
 *    space, so codes bounded by `_` (e.g. `A2_KH`) tokenize correctly (a bare
 *    `\b` treats `_` as a word char and would miss them).
 *  - Bound the digit run to 1–2, rejecting resolution/codec tokens (`720p`,
 *    `1080p`, `h264`) while accepting real codes up to `A99` / `99A`.
 *  - Always return the code upper-cased.
 */

// Either letter+1–2 digits (A1, M8, Z12) or 1–2 digits+letter (1A, 12B), as a
// whole token (\b guards both ends). First match in the name wins.
const J_CODE_RE = /\b([a-z]\d{1,2}|\d{1,2}[a-z])\b/i;
const BARE_J_CODE_RE = /^([a-z]\d{1,2}|\d{1,2}[a-z])$/i;
const FILE_EXT_RE = /\.[a-z0-9]{1,5}$/i;

/**
 * Parse the J-Code out of an asset/video name. Returns the normalized
 * (upper-cased) code, or `null` when the name carries no parseable code.
 *
 * Examples: `"A1.mp4" → "A1"`, `"A2_KH.mp4" → "A2"`, `"M1_1.mp4" → "M1"`,
 * `"1A.mp4" → "1A"`, `"  e1 " → "E1"`, `"Pass 3 - H2 final.mov" → "H2"`
 * (first token wins), `"intro.mp4" → null`, `"render_h264.mp4" → null`.
 */
export function parseJCode(name: string | null | undefined): string | null {
  if (!name) return null;
  // Drop a trailing extension BEFORE separator normalization so ".mp4" cannot be
  // read as the letter-major code "P4".
  const withoutExt = String(name).trim().replace(FILE_EXT_RE, '');
  // Collapse remaining separators (`_`, `-`, spaces, parens, internal dots) so
  // codes bounded by any of them tokenize the same way.
  const normalized = withoutExt.replace(/[^a-z0-9]+/gi, ' ').trim();
  const match = normalized.match(J_CODE_RE);
  return match ? match[1].toUpperCase() : null;
}

/** True when `name` contains a parseable J-Code. */
export function hasJCode(name: string | null | undefined): boolean {
  return parseJCode(name) !== null;
}

/** Normalize an already-known bare code (e.g. a sheet J-CODE cell) for
 *  comparison (upper/trim). Returns null if it isn't a valid standalone code. */
export function normalizeJCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = String(code).trim();
  return BARE_J_CODE_RE.test(trimmed) ? trimmed.toUpperCase() : null;
}
