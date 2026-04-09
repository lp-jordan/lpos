/** Size of each chunk sent during a chunked upload (20 MB). */
export const UPLOAD_CHUNK_SIZE_BYTES = 20 * 1024 * 1024;

/** Allowed media file extensions for upload. */
export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mts', '.mxf',
  '.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg',
]);
