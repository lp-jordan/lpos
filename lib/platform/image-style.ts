/**
 * Builds the text prompt for a generated tile hero image.
 *
 * The house style lives in `docs/platform-image-style.md` — the block between
 * the STYLE_DIRECTIVE markers is the single source of truth and is injected
 * verbatim into every prompt. Editing that file changes future generations with
 * no code change (the file is re-read per call). A baked-in fallback keeps
 * generation working if the doc is missing at runtime.
 *
 * On duotone/geometric tiles the image is brand duotone-mapped afterward, so the
 * model's job is composition, subject, and light — not final colour. On hero
 * tiles the image is shown as-is (natural colour), so the same cinematic house
 * style reads as the final look.
 */
import fs from 'node:fs';
import path from 'node:path';

// Canonical docs live at the workspace root (../docs from the app cwd). The
// former lpos-dashboard/docs copy was retired in the 2026-08-26 docs
// reconciliation; the candidate list keeps this resilient if the cwd differs.
const STYLE_DOC_CANDIDATES = [
  path.join(process.cwd(), '..', 'docs', 'platform-image-style.md'),
  path.join(process.cwd(), 'docs', 'platform-image-style.md'),
];
const START = '<!-- STYLE_DIRECTIVE:START -->';
const END = '<!-- STYLE_DIRECTIVE:END -->';

const FALLBACK_DIRECTIVE =
  'Cinematic editorial photograph. Natural directional light, shallow depth of '
  + 'field, muted near-monochromatic palette, premium and restrained. Calm, '
  + 'darker top third with negative space for a title. A single clear subject, '
  + 'no text, no letters, no logos, no watermark. 3:4 portrait.';

/** Extract the STYLE_DIRECTIVE block from the style doc, else the fallback. */
export function loadStyleDirective(): string {
  try {
    const styleDoc = STYLE_DOC_CANDIDATES.find((p) => fs.existsSync(p)) ?? STYLE_DOC_CANDIDATES[0];
    const raw = fs.readFileSync(styleDoc, 'utf8');
    const i = raw.indexOf(START);
    const j = raw.indexOf(END);
    if (i >= 0 && j > i) {
      const block = raw
        .slice(i + START.length, j)
        .split('\n')
        .map((l) => l.replace(/^>\s?/, '').trim()) // strip markdown blockquote markers
        .filter(Boolean)
        .join(' ')
        .trim();
      if (block) return block;
    }
  } catch { /* fall through to fallback */ }
  return FALLBACK_DIRECTIVE;
}

// Theme → concrete subject direction. Mirrors the archetype rules in
// tile-background.ts so a tile's generated photo matches its designed look.
const SUBJECT_RULES: Array<{ re: RegExp; subject: string }> = [
  { re: /convers|interview|talk|discuss|guest|panel|coach|listen/i, subject: 'two people mid-conversation in a considered modern space, warm side light, environmental' },
  { re: /team|meet|group|audience|culture|collaborat/i, subject: 'a small group working together in a warm, modern room' },
  { re: /board|office|present|stage|speak|keynote/i, subject: 'a modern boardroom or stage, figures at a table, architectural lines' },
  { re: /eval|measur|score|result|outcome|review|assess|data|metric|track|progress|journal|note|plan.?book/i, subject: 'hands with a notebook and pen on a desk, raking overhead light, quiet focus' },
  { re: /plan|action|implement|strateg|system|process|build|framework|method|structur|execut|step/i, subject: 'a lone figure in a large architectural space, strong lines, a sense of scale and structure' },
  { re: /pray|faith|worship|spirit|god|bible|scriptur|devotion/i, subject: 'a quiet, contemplative moment in soft window light, reverent and still' },
  { re: /fit|train|physical|body|health|exercise|strength|discipline/i, subject: 'an athletic training moment in early light, effort and texture' },
  { re: /ego|trap|drift|mindset|belief|think|stuck|inner|self|treasure|guard/i, subject: 'a solitary figure at a threshold or horizon, metaphorical, light emerging from darkness' },
  { re: /intro|start|begin|welcome|overview|foundation|journey|course|compass/i, subject: 'an open landscape at first light, a path or doorway, a sense of beginning' },
];

/** Pick a concrete subject phrase from the tile's title + description. */
export function subjectFor(title: string, description: string): string {
  const text = `${title} ${description || ''}`;
  for (const r of SUBJECT_RULES) if (r.re.test(text)) return r.subject;
  const base = (description || title || 'an evocative, cinematic scene').trim();
  return base.length > 160 ? base.slice(0, 160) : base;
}

/** The full prompt: concrete subject + the house STYLE_DIRECTIVE. */
export function buildImagePrompt(title: string, description: string): string {
  return `${subjectFor(title, description)}. ${loadStyleDirective()}`;
}
