/**
 * Client-side export of a pass's designed tile backgrounds.
 *
 * The browser rasterises each tile's SVG (so grain/duotone/blur match the
 * on-screen preview exactly — server rasterisers don't honour those filters),
 * then everything is packed into a ZIP of labelled PNGs for manual placement
 * in LeaderPass admin. Filenames: `C{cat}T{tile}_{name}.png` (1-based indices).
 *
 * This is the ONLY path designed art takes toward LeaderPass. It never touches
 * the Cloudflare video poster (that stays a manual, separate concern).
 */
import { buildTileBackgroundSVG, type Brand } from './tile-background';
import { makeZip, type ZipEntry } from './zip';
import type { PassTree } from '@/lib/store/platform-pass-store';

const EXPORT_W = 600;
const EXPORT_H = 840; // 5:7 portrait, 2× the 300×420 design space

function safeName(s: string): string {
  return (s || 'tile')
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'tile';
}

/** Same-origin fetch of a tile's source image → base64 data URI (so the export
 *  SVG is self-contained; SVG-as-image blocks external references). */
async function imageDataUri(tileId: string): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/platform/tiles/${tileId}/image`);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string | undefined>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => resolve(undefined);
      fr.readAsDataURL(blob);
    });
  } catch { return undefined; }
}

function svgToPng(svg: string, w: number, h: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { URL.revokeObjectURL(url); reject(new Error('no 2d context')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('toBlob failed')); return; }
          blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
        }, 'image/png');
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
    img.src = url;
  });
}

/** Rasterise every tile and trigger a ZIP download. Returns the tile count. */
export async function exportPassTiles(pass: PassTree, brand: Brand): Promise<{ count: number }> {
  const folder = safeName(pass.title);
  const entries: ZipEntry[] = [];

  for (let c = 0; c < pass.categories.length; c++) {
    const cat = pass.categories[c];
    for (let t = 0; t < cat.tiles.length; t++) {
      const tile = cat.tiles[t];
      const canImage = tile.archetype === 'duotone' || tile.archetype === 'geometric';
      const imageHref = canImage && tile.imageMime ? await imageDataUri(tile.id) : undefined;
      const svg = buildTileBackgroundSVG(brand, tile, { grain: tile.grain, width: EXPORT_W, height: EXPORT_H, imageHref, duoShadow: tile.duoShadow, duoLight: tile.duoLight });
      const png = await svgToPng(svg, EXPORT_W, EXPORT_H);
      entries.push({ name: `${folder}/C${c + 1}T${t + 1}_${safeName(tile.title)}.png`, data: png });
    }
  }

  if (entries.length === 0) return { count: 0 };

  const zip = makeZip(entries);
  const href = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = href;
  a.download = `${folder} tiles.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
  return { count: entries.length };
}
