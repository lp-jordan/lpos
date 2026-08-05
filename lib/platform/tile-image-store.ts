/**
 * On-disk location for platform tile source images.
 *
 * Source images (uploaded, pulled from a video poster frame, or produced by the
 * generation seam) live LOCAL / same-origin so the browser can composite and
 * export them without tainting the canvas. This never touches the Cloudflare
 * video poster. Shared by the tile image + generate routes so the path can't
 * drift between the writer and the reader.
 */
import path from 'node:path';

export const TILE_IMG_DIR = path.join(
  process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data'),
  'platform',
  'tile-images',
);

/** Absolute path for a tile's image bytes. Tile id is sanitised to a safe basename. */
export function tileImagePath(tileId: string): string {
  return path.join(TILE_IMG_DIR, tileId.replace(/[^a-zA-Z0-9_-]/g, ''));
}
