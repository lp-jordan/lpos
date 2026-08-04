/**
 * Deterministic, seeded tile-background generator for the Platform pass studio.
 *
 * Pure TS (no DOM) so it renders identically client-side (live preview) and
 * server-side (Phase 3 PNG export). A tile's look is fully determined by
 * (brand, archetype, paletteIndex, seed) — same inputs → same SVG, always.
 *
 * Ported from the "Tile Studio" prototype. See docs/platform-passes.md.
 */

export type TileArchetype = 'gradient' | 'geometric' | 'duotone' | 'hero';
export type GrainLevel = 'none' | 'subtle' | 'film';

export interface Brand {
  key: string;
  name: string;
  swatch: string;
  accents: string[];
  duoDark: string;
  duoLight: string;
  gold: string;
}

export const BRANDS: Record<string, Brand> = {
  leaderpass: {
    // LPOS house palette — gold, steel/navy blues, slate. Cohesive, not rainbow.
    key: 'leaderpass', name: 'LeaderPass', swatch: '#DBAF5F',
    accents: ['#DBAF5F', '#2F6FB0', '#1E3A5F', '#67819A', '#C8933A'],
    duoDark: '#0B1219', duoLight: '#4E7BA6', gold: '#E4B84A',
  },
  aurora: {
    key: 'aurora', name: 'Aurora', swatch: '#14B8A6',
    accents: ['#14B8A6', '#4F5BD5', '#2E9BE0', '#7C4DD0', '#2FBF9E'],
    duoDark: '#0A1420', duoLight: '#3D7CA8', gold: '#7EC8D8',
  },
  ember: {
    key: 'ember', name: 'Ember', swatch: '#C2461F',
    accents: ['#C2461F', '#E0952B', '#D8B24A', '#9E4E2C', '#8A7A2E'],
    duoDark: '#17110B', duoLight: '#7A5636', gold: '#E7C25A',
  },
  harbor: {
    key: 'harbor', name: 'Harbor', swatch: '#2E6E8E',
    accents: ['#2E6E8E', '#3FA7A0', '#5C7CA6', '#8AA6B8', '#D8B26D'],
    duoDark: '#0B1620', duoLight: '#5A87A0', gold: '#D8B26D',
  },
  orchid: {
    key: 'orchid', name: 'Orchid', swatch: '#B0308E',
    accents: ['#B0308E', '#7C3FD0', '#E24A8B', '#F06A4C', '#5C4BC0'],
    duoDark: '#150A1A', duoLight: '#8A5A96', gold: '#E7B85A',
  },
};

export const DEFAULT_BRAND = 'leaderpass';

/** Partial overrides stored per-pass to customise a brand's parameters. */
export interface BrandConfig {
  name?: string;
  accents?: string[];
  duoDark?: string;
  duoLight?: string;
  gold?: string;
}

export function getBrand(key: string | null | undefined): Brand {
  return BRANDS[key ?? ''] ?? BRANDS[DEFAULT_BRAND];
}

/**
 * Resolves the effective brand for a pass: the named default brand, with any
 * per-pass `config` overrides merged on top. Swatch tracks the first accent.
 */
export function resolveBrand(key: string | null | undefined, config?: BrandConfig | null): Brand {
  const base = getBrand(key);
  if (!config) return base;
  const accents = config.accents && config.accents.length ? config.accents : base.accents;
  return {
    ...base,
    name: config.name ?? base.name,
    accents,
    duoDark: config.duoDark ?? base.duoDark,
    duoLight: config.duoLight ?? base.duoLight,
    gold: config.gold ?? base.gold,
    swatch: accents[0] ?? base.swatch,
  };
}

export interface TileRecipe {
  archetype: TileArchetype;
  paletteIndex: number;
  seed: number;
  stockQuery: string;
}

/** Minimal shape needed to render a background. */
export interface TileVisual {
  id: string;
  archetype: TileArchetype;
  paletteIndex: number;
  seed: number;
}

// ── Deterministic hashing / RNG ──────────────────────────────────────────────

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Colour helpers ───────────────────────────────────────────────────────────

function hx(h: string): [number, number, number] {
  const c = h.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
function toHex(r: number[]): string {
  return '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(a: string, b: string, t: number): string {
  const A = hx(a), B = hx(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
function unit(h: string): string[] {
  return hx(h).map((v) => (v / 255).toFixed(3));
}

// ── Description → style recipe ───────────────────────────────────────────────

const RULES: Array<{ re: RegExp; arch: TileArchetype; q: string }> = [
  { re: /convers|story|interview|talk|team|meet|audience|people|coach|listen|guest|panel/i, arch: 'duotone', q: 'candid team conversation, warm light' },
  { re: /eval|measur|score|result|outcome|review|assess|data|metric|track|progress/i, arch: 'duotone', q: 'reviewing notes and results on paper' },
  { re: /board|room|office|present|stage|speak|keynote/i, arch: 'duotone', q: 'modern boardroom, people at table' },
  { re: /plan|action|implement|strateg|system|process|build|framework|backup|execut|step|method|structur/i, arch: 'geometric', q: '' },
  { re: /ego|trap|drift|mindset|idea|principle|belief|think|stuck|why|inner|self/i, arch: 'gradient', q: '' },
  { re: /intro|start|begin|welcome|overview|foundation/i, arch: 'gradient', q: '' },
];

export function deriveRecipe(title: string, description: string, brand: Brand): TileRecipe {
  const text = `${title} ${description || ''}`;
  let arch: TileArchetype = 'gradient';
  let q = '';
  for (const r of RULES) { if (r.re.test(text)) { arch = r.arch; q = r.q; break; } }
  const seed = hashStr(`${title}|${description || ''}|${arch}`);
  const paletteIndex = hashStr(title || 'x') % brand.accents.length;
  if (arch === 'duotone' && !q) q = (title || 'abstract').toLowerCase();
  return { archetype: arch, paletteIndex, seed, stockQuery: q };
}

// ── SVG builder ──────────────────────────────────────────────────────────────

const W = 300, H = 420;

function scrim(id: string): string {
  return `<defs><linearGradient id="scr_${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="#000" stop-opacity="0.5"/>`
    + `<stop offset="55%" stop-color="#000" stop-opacity="0"/></linearGradient></defs>`
    + `<rect width="${W}" height="230" fill="url(#scr_${id})"/>`;
}

function grainOverlay(id: string, level: GrainLevel): string {
  if (level === 'none') return '';
  const opacity = level === 'film' ? 0.62 : 0.34;
  return `<defs><filter id="grain_${id}" x="0" y="0" width="100%" height="100%">`
    + `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="n"/>`
    + `<feColorMatrix in="n" type="saturate" values="0"/></filter></defs>`
    + `<rect width="${W}" height="${H}" filter="url(#grain_${id})" opacity="${opacity}" style="mix-blend-mode:overlay"/>`;
}

/**
 * Returns a self-contained SVG string for a tile background.
 * Grain is applied only to gradient & duotone (geometric stays crisp).
 */
export function buildTileBackgroundSVG(
  b: Brand,
  tile: TileVisual,
  opts: { grain?: GrainLevel; width?: number | string; height?: number | string } = {},
): string {
  const acc = b.accents[tile.paletteIndex % b.accents.length];
  const r = rng(tile.seed);
  const id = `${tile.id}_${b.key}`;
  const grain = opts.grain ?? 'subtle';
  let inner = '';
  let wantScrim = true;
  let grainable = false;

  if (tile.archetype === 'hero') {
    inner = `<rect width="${W}" height="${H}" fill="${mix(b.duoDark, '#000', 0.2)}"/>`
      + `<rect x="14" y="14" width="272" height="392" rx="10" fill="none" stroke="${mix(b.duoLight, '#fff', 0.1)}" stroke-width="1.5" stroke-dasharray="7 7" opacity="0.6"/>`
      + `<g fill="none" stroke="${mix(b.duoLight, '#fff', 0.2)}" stroke-width="3" opacity="0.85" transform="translate(150 200)">`
      + `<rect x="-34" y="-30" width="68" height="50" rx="6"/><circle cx="0" cy="-5" r="12"/></g>`;
    wantScrim = false;
  } else if (tile.archetype === 'gradient') {
    const angle = Math.floor(r() * 360);
    const lite = mix(acc, '#ffffff', 0.14), dark = mix(acc, b.duoDark, 0.78);
    const gx = (0.2 + r() * 0.6).toFixed(2), gy = (0.15 + r() * 0.5).toFixed(2);
    const bx = Math.floor(40 + r() * 220), by = Math.floor(40 + r() * 200);
    inner = `<defs>`
      + `<linearGradient id="g_${id}" gradientTransform="rotate(${angle} 0.5 0.5)">`
      + `<stop offset="0%" stop-color="${lite}"/><stop offset="46%" stop-color="${acc}"/><stop offset="100%" stop-color="${dark}"/></linearGradient>`
      + `<radialGradient id="glow_${id}" cx="${gx}" cy="${gy}" r="0.75">`
      + `<stop offset="0%" stop-color="${mix(acc, '#ffffff', 0.35)}" stop-opacity="0.55"/><stop offset="60%" stop-color="${acc}" stop-opacity="0"/></radialGradient>`
      + `<filter id="bloom_${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter></defs>`
      + `<rect width="${W}" height="${H}" fill="url(#g_${id})"/>`
      + `<ellipse cx="${bx}" cy="${by}" rx="130" ry="165" fill="${mix(acc, '#ffffff', 0.42)}" opacity="0.42" filter="url(#bloom_${id})"/>`
      + `<rect width="${W}" height="${H}" fill="url(#glow_${id})"/>`;
    grainable = true;
  } else if (tile.archetype === 'geometric') {
    const base = b.duoDark, c1 = acc, c2 = b.accents[(tile.paletteIndex + 1) % b.accents.length], gold = b.gold;
    const flip = r() < 0.5 ? '' : ` transform="translate(${W} 0) scale(-1 1)"`;
    const curve = r() < 0.5;
    let shapes: string;
    if (!curve) {
      const off = Math.floor(r() * 90);
      shapes = `<g transform="rotate(-34 150 210)">`
        + `<rect x="-220" y="${60 + off}" width="740" height="150" fill="${c1}"/>`
        + `<rect x="-220" y="${210 + off}" width="740" height="15" fill="${gold}"/>`
        + `<rect x="-220" y="${225 + off}" width="740" height="360" fill="${c2}"/></g>`;
    } else {
      shapes = `<path d="M0,${250 + Math.floor(r() * 40)} C 90,200 200,320 300,220 L300,420 L0,420 Z" fill="${c1}"/>`
        + `<path d="M0,${330 + Math.floor(r() * 30)} C 110,290 210,390 300,300 L300,420 L0,420 Z" fill="${c2}" opacity="0.96"/>`;
    }
    const dotLeft = r() < 0.5;
    inner = `<defs><pattern id="dot_${id}" width="15" height="15" patternUnits="userSpaceOnUse">`
      + `<circle cx="3" cy="3" r="2" fill="${mix(c2, '#ffffff', 0.25)}" opacity="0.55"/></pattern></defs>`
      + `<rect width="${W}" height="${H}" fill="${base}"/>`
      + `<g${flip}>${shapes}</g>`
      + `<rect x="${dotLeft ? 0 : 150}" y="0" width="150" height="150" fill="url(#dot_${id})" opacity="0.7"/>`;
  } else {
    // duotone: atmospheric tinted "image" stand-in (real path composites a photo).
    const dark = b.duoDark, light = r() < 0.5 ? acc : b.duoLight;
    const du = unit(dark), lu = unit(light);
    const bf = (0.008 + r() * 0.014).toFixed(4);
    const seedInt = tile.seed % 100;
    const x1 = Math.floor(20 + r() * 260), y1 = Math.floor(20 + r() * 200);
    const x2 = Math.floor(20 + r() * 260), y2 = Math.floor(180 + r() * 220);
    inner = `<defs>`
      + `<linearGradient id="dg_${id}" x1="0" y1="0" x2="0.7" y2="1">`
      + `<stop offset="0%" stop-color="${mix(dark, '#000', 0.12)}"/><stop offset="100%" stop-color="${mix(light, dark, 0.42)}"/></linearGradient>`
      + `<filter id="soft_${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>`
      + `<filter id="duo_${id}" x="0" y="0" width="100%" height="100%">`
      + `<feTurbulence type="fractalNoise" baseFrequency="${bf}" numOctaves="3" seed="${seedInt}" stitchTiles="stitch" result="n"/>`
      + `<feColorMatrix in="n" type="saturate" values="0" result="g"/>`
      + `<feComponentTransfer in="g"><feFuncR type="table" tableValues="${du[0]} ${lu[0]}"/>`
      + `<feFuncG type="table" tableValues="${du[1]} ${lu[1]}"/><feFuncB type="table" tableValues="${du[2]} ${lu[2]}"/></feComponentTransfer></filter>`
      + `<radialGradient id="vig_${id}" cx="0.5" cy="0.4" r="0.8">`
      + `<stop offset="42%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.6"/></radialGradient></defs>`
      + `<rect width="${W}" height="${H}" fill="url(#dg_${id})"/>`
      + `<g filter="url(#soft_${id})" opacity="0.72"><ellipse cx="${x1}" cy="${y1}" rx="115" ry="145" fill="${light}"/>`
      + `<ellipse cx="${x2}" cy="${y2}" rx="125" ry="120" fill="${dark}"/></g>`
      + `<rect width="${W}" height="${H}" filter="url(#duo_${id})" style="mix-blend-mode:soft-light" opacity="0.62"/>`
      + `<rect width="${W}" height="${H}" fill="url(#vig_${id})"/>`;
    grainable = true;
  }

  const width = opts.width ?? '100%';
  const height = opts.height ?? '100%';
  return `<svg viewBox="0 0 ${W} ${H}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" style="display:block" xmlns="http://www.w3.org/2000/svg">`
    + inner
    + (wantScrim ? scrim(id) : '')
    + (grainable ? grainOverlay(id, grain) : '')
    + `</svg>`;
}
