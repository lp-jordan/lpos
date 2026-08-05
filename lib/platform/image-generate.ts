/**
 * The single seam where a tile hero image is produced from a text prompt.
 *
 * With OPENAI_API_KEY set, this calls the image model (gpt-image-1 by default)
 * and returns real PNG bytes. WITHOUT a key it returns a tonal placeholder SVG so
 * the whole pipeline — prompt build → generate → local store → render → export —
 * still works end-to-end. Callers only ever see `{ bytes, mime, placeholder }`.
 * On a live failure (org-unverified, content-policy refusal, timeout) it throws,
 * and the route keeps the tile's existing art rather than swapping in a placeholder.
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

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1';
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE ?? '1024x1536'; // 2:3 portrait, sliced to the 3:4 tile
const IMAGE_TIMEOUT_MS = 90_000;

export async function generateTileImage(prompt: string): Promise<GeneratedImage> {
  const key = process.env.OPENAI_API_KEY;

  // No key configured → placeholder so the whole pipeline still works end-to-end.
  if (!key) return { bytes: Buffer.from(PLACEHOLDER_SVG, 'utf8'), mime: 'image/svg+xml', placeholder: true };

  // Live generation. gpt-image-1 always returns base64 (no URL). On failure
  // (org-unverified 403, content-policy refusal, timeout) we THROW so the route
  // reports it and the tile keeps its existing art — we never silently swap in a
  // placeholder when a real image was expected.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, quality: 'medium', n: 1 }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`Image API ${r.status}: ${detail.slice(0, 240)}`);
    }
    const data = (await r.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('Image API returned no image data.');
    return { bytes: Buffer.from(b64, 'base64'), mime: 'image/png', placeholder: false };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`Image generation timed out after ${IMAGE_TIMEOUT_MS / 1000}s.`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
