/**
 * Silent pages — three unlisted full-screen loop surfaces (`/silent-structure`,
 * `/silent-produce`, `/silent-place`) that each play one selected LPOS asset
 * muted, full-bleed, forever. Built for display screens: no chrome, no controls,
 * no audio.
 *
 * This module is PURE (constants + types only, no SQLite import) so the admin
 * picker can import it from the client bundle. The persistence side lives in
 * `lib/store/silent-pages-store.ts`, which is server-only.
 */

export const SILENT_PAGE_SLUGS = ['structure', 'produce', 'place'] as const;

export type SilentPageSlug = (typeof SILENT_PAGE_SLUGS)[number];

export const SILENT_PAGE_LABELS: Record<SilentPageSlug, string> = {
  structure: 'Structure',
  produce:   'Produce',
  place:     'Place',
};

/** Route path for a slug — the URL you point the display device at. */
export function silentPagePath(slug: SilentPageSlug): string {
  return `/silent-${slug}`;
}

/** Which asset a silent page is currently pointed at. Null-equivalent = unset. */
export interface SilentPageSelection {
  projectId: string;
  assetId:   string;
}

/**
 * Extensions a browser `<video>` will actually decode. The stream route happily
 * serves `.mov` / `.mkv` / `.mxf`, but those fail silently in the player (black
 * frame, no error event on some codecs) — so the picker warns rather than
 * letting an admin point a display screen at something that won't play.
 *
 * `.mov` is deliberately excluded: an H.264 MOV usually plays in Safari and
 * Chrome, but ProRes MOVs (the common case here) do not, and we can't tell
 * which is which from the extension alone.
 */
export const BROWSER_PLAYABLE_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm']);

export function isBrowserPlayable(filePathOrName: string | null | undefined): boolean {
  if (!filePathOrName) return false;
  const dot = filePathOrName.lastIndexOf('.');
  if (dot === -1) return false;
  return BROWSER_PLAYABLE_EXTENSIONS.has(filePathOrName.slice(dot).toLowerCase());
}

export function isSilentPageSlug(value: string): value is SilentPageSlug {
  return (SILENT_PAGE_SLUGS as readonly string[]).includes(value);
}
