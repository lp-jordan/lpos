/**
 * Shared media-kind detection.
 *
 * Used to route assets to video-only services (e.g. Cloudflare Stream, which
 * rejects audio/image/doc files). Deliberately broad — matches on MIME type
 * first, then falls back to the file extension, so a missing/odd MIME still
 * resolves common container formats.
 *
 * (Several routes/components carry their own local VIDEO_MIMES/VIDEO_EXTS
 * sets — those can converge on this helper in a later cleanup; not refactored
 * here to keep the CF auto-upload change minimal.)
 */

const VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'video/webm', 'video/mxf', 'video/m4v', 'video/mts', 'video/mpeg',
  'video/3gpp', 'video/x-flv', 'video/x-ms-wmv', 'video/avi', 'video/ogg',
  'video/x-m4v', 'video/dvd', 'video/x-mpeg',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.mxf', '.webm', '.m4v', '.mts',
  '.m2ts', '.ts', '.mpg', '.mpeg', '.3gp', '.flv', '.wmv', '.ogv', '.qt',
]);

/**
 * Broad "is this a video asset" check. Matches MIME first (case-insensitive),
 * then the file extension. Returns false for null/empty inputs.
 */
export function isVideoFile(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  if (mimeType && VIDEO_MIME_TYPES.has(mimeType.toLowerCase())) return true;
  const ext = (filename ?? '').toLowerCase().match(/\.[a-z0-9]{1,5}$/)?.[0] ?? '';
  return VIDEO_EXTENSIONS.has(ext);
}
