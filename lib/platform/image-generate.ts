/**
 * The single seam where a tile hero image is produced from a text prompt.
 *
 * TODAY: returns a fixed placeholder so the whole pipeline — prompt build →
 * generate → local store → duotone render → export — works end-to-end with no
 * API key. The placeholder is a tonal, photographic-ish SVG that duotones on
 * brand exactly like a real hero would, so you can see the wiring.
 *
 * TO GO LIVE: implement the OpenAI branch below (kept commented) and set
 * OPENAI_API_KEY in Doppler. Nothing else in the pipeline changes — callers
 * only ever see `{ bytes, mime }`.
 */

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
  /** True while running on the placeholder (no real generation happened). */
  placeholder: boolean;
}

// A neutral, tonal stand-in. Desaturates + duotone-maps like a photo; the faint
// reticle + label read as "generated placeholder" in the raw image.
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400" preserveAspectRatio="xMidYMid slice">'
  + '<defs>'
  + '<linearGradient id="pg" x1="0" y1="0" x2="0.6" y2="1">'
  + '<stop offset="0%" stop-color="#3c4147"/><stop offset="52%" stop-color="#6d747b"/><stop offset="100%" stop-color="#1e2228"/>'
  + '</linearGradient>'
  + '<filter id="pb" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="26"/></filter>'
  + '</defs>'
  + '<rect width="300" height="400" fill="url(#pg)"/>'
  + '<ellipse cx="108" cy="138" rx="120" ry="150" fill="#cbd0d5" opacity="0.5" filter="url(#pb)"/>'
  + '<ellipse cx="232" cy="322" rx="120" ry="120" fill="#161a1f" opacity="0.6" filter="url(#pb)"/>'
  + '<circle cx="150" cy="205" r="26" fill="none" stroke="#e9ecef" stroke-width="2" opacity="0.66"/>'
  + '<path d="M150 176 L150 234 M121 205 L179 205" stroke="#e9ecef" stroke-width="2" opacity="0.66"/>'
  + '<text x="150" y="372" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="11" letter-spacing="2" fill="#e9ecef" opacity="0.5">GENERATED · PLACEHOLDER</text>'
  + '</svg>';

export async function generateTileImage(prompt: string): Promise<GeneratedImage> {
  // ── LIVE SEAM (wire up when OPENAI_API_KEY is provisioned) ──────────────────
  //
  // import OpenAI from 'openai';
  // const key = process.env.OPENAI_API_KEY;
  // if (key) {
  //   const openai = new OpenAI({ apiKey: key });
  //   const r = await openai.images.generate({
  //     model: 'gpt-image-1',
  //     prompt,
  //     size: '1024x1536',   // 2:3 portrait; sliced to the 3:4 tile on render
  //     quality: 'medium',   // plenty — we duotone-lock the colour afterward
  //     n: 1,
  //   });
  //   const b64 = r.data?.[0]?.b64_json;
  //   if (b64) return { bytes: Buffer.from(b64, 'base64'), mime: 'image/png', placeholder: false };
  // }
  //
  // Notes: gpt-image-1 requires OpenAI org verification and always returns
  // base64 (no URL). On a content-policy refusal it throws — the route catches
  // it and the caller falls back to the procedural duotone stand-in.
  // ───────────────────────────────────────────────────────────────────────────
  void prompt;
  return { bytes: Buffer.from(PLACEHOLDER_SVG, 'utf8'), mime: 'image/svg+xml', placeholder: true };
}
