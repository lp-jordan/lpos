'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PassTree, PlatformTile, PassStatus } from '@/lib/store/platform-pass-store';
import {
  BRANDS, getBrand, buildTileBackgroundSVG, deriveRecipe,
  type TileArchetype, type GrainLevel,
} from '@/lib/platform/tile-background';

const ARCHETYPES: TileArchetype[] = ['gradient', 'geometric', 'duotone', 'hero'];
const GRAINS: GrainLevel[] = ['none', 'subtle', 'film'];

function fmtDur(s: number | null): string {
  if (s == null) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m ${r}s`;
}

export function PassWorkspace({ passId, onBack }: { passId: string; onBack: () => void }) {
  const [tree, setTree] = useState<PassTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [grain, setGrain] = useState<GrainLevel>('subtle');
  const [showTitles, setShowTitles] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/platform/passes/${passId}`);
    if (res.ok) setTree((await res.json()).pass);
    setLoading(false);
  }, [passId]);

  useEffect(() => { load(); }, [load]);

  const applyTile = (t: PlatformTile) => setTree((prev) => prev && ({
    ...prev,
    categories: prev.categories.map((c) => ({
      ...c, tiles: c.tiles.map((x) => (x.id === t.id ? t : x)),
    })),
  }));

  // ── Pass-level ──
  async function patchPass(body: { title?: string; status?: PassStatus; brand?: string }) {
    const res = await fetch(`/api/platform/passes/${passId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) { const { pass } = await res.json(); setTree((p) => p && { ...p, ...pass }); }
  }
  async function changeBrand(brand: string) {
    await patchPass({ brand });
    await load(); // recolour every tile
  }

  // ── Category-level ──
  async function addCategory() {
    await fetch(`/api/platform/passes/${passId}/categories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New category' }),
    });
    load();
  }
  async function renameCategory(id: string, title: string) {
    await fetch(`/api/platform/categories/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
  }
  async function deleteCategory(id: string) {
    await fetch(`/api/platform/categories/${id}`, { method: 'DELETE' });
    load();
  }

  // ── Tile-level ──
  async function addTile(categoryId: string) {
    const res = await fetch(`/api/platform/categories/${categoryId}/tiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New tile' }),
    });
    await load();
    if (res.ok) { const { tile } = await res.json(); setSelected(tile.id); }
  }
  async function patchTile(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/platform/tiles/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) applyTile((await res.json()).tile);
  }
  async function deleteTile(id: string) {
    await fetch(`/api/platform/tiles/${id}`, { method: 'DELETE' });
    setSelected(null);
    load();
  }

  if (loading || !tree) {
    return <div style={{ padding: 48, color: 'var(--muted)' }}>Loading pass…</div>;
  }

  const brand = getBrand(tree.brand);
  const selectedTile: PlatformTile | null = selected
    ? tree.categories.flatMap((c) => c.tiles).find((t) => t.id === selected) ?? null
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 0px)' }}>
      {/* Toolbar */}
      <div style={toolbar}>
        <button onClick={onBack} style={iconBtn} title="Back to passes">←</button>
        <input
          defaultValue={tree.title}
          onBlur={(e) => patchPass({ title: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={titleInput}
          aria-label="Pass title"
        />
        <span style={statusPill}>{tree.status}</span>
        <div style={{ flex: 1 }} />
        <Segmented label="Brand" options={Object.values(BRANDS).map((b) => ({ key: b.key, label: b.name, swatch: b.swatch }))}
          value={tree.brand} onChange={changeBrand} />
        <Segmented label="Grain" options={GRAINS.map((g) => ({ key: g, label: g[0].toUpperCase() + g.slice(1) }))}
          value={grain} onChange={(v) => setGrain(v as GrainLevel)} />
        <button onClick={() => setShowTitles((s) => !s)} style={{ ...chip, ...(showTitles ? chipOn : {}) }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: showTitles ? 'var(--accent)' : 'var(--muted-soft)' }} /> Platform text
        </button>
        <button onClick={() => alert('Export (manifest + zip of tile PNGs) — Phase 4.')} style={exportBtn}>Export ▸</button>
      </div>

      {/* Board */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0 60px' }}>
        {tree.categories.map((cat) => (
          <section key={cat.id} style={{ padding: '16px 24px 4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <input
                defaultValue={cat.title}
                onBlur={(e) => renameCategory(cat.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={catInput}
                aria-label="Category name"
              />
              <span style={{ fontSize: 11, color: 'var(--muted-soft)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                {cat.tiles.length} {cat.tiles.length === 1 ? 'tile' : 'tiles'}
              </span>
              <button onClick={() => deleteCategory(cat.id)} style={faintBtn}>Delete</button>
            </div>
            <div style={{ display: 'flex', gap: 14, overflowX: 'auto', padding: '4px 2px 12px' }}>
              {cat.tiles.map((t) => (
                <div key={t.id} style={{ flex: '0 0 auto', width: 152, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <div
                    onClick={() => setSelected(t.id)}
                    style={{ ...tileCard, boxShadow: selected === t.id ? '0 0 0 2.5px var(--accent)' : '0 2px 8px rgba(0,0,0,.3)' }}
                  >
                    <div style={{ position: 'absolute', inset: 0 }}
                      dangerouslySetInnerHTML={{ __html: buildTileBackgroundSVG(tree.brand, t, { grain }) }} />
                    {showTitles && <div style={tileTitle}>{t.title}</div>}
                    <div style={tileBadge}>{t.archetype}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted-soft)', padding: '0 2px' }}>
                    {t.mediaAssetId ? <span>▤ {t.mediaKind ?? 'media'}{t.durationSec != null ? ` · ${fmtDur(t.durationSec)}` : ''}</span>
                      : <span style={{ color: 'var(--muted-soft)' }}>○ not linked</span>}
                  </div>
                </div>
              ))}
              <button onClick={() => addTile(cat.id)} style={addTileBtn}>
                <span style={{ fontSize: 24, fontWeight: 300 }}>+</span>Add tile
              </button>
            </div>
          </section>
        ))}
        <button onClick={addCategory} style={addCatBtn}>+  New category</button>

        <div style={prodNote}>
          <b style={{ color: 'var(--text)' }}>Phase 1</b> — staging only. Tile backgrounds render live; linking media,
          persisting art to Cloudflare, Pass&nbsp;Prep and Export come next. LeaderPass admin remains the source of truth.
        </div>
      </div>

      {/* Inspector */}
      {selectedTile && (
        <>
          <div onClick={() => setSelected(null)} style={scrimBg} />
          <aside style={inspector}>
            <div style={inspHead}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)' }}>Tile background</span>
              <button onClick={() => setSelected(null)} style={iconBtn}>✕</button>
            </div>
            <div style={inspBody}>
              <div style={previewFrame}>
                <div style={{ position: 'absolute', inset: 0 }}
                  dangerouslySetInnerHTML={{ __html: buildTileBackgroundSVG(tree.brand, selectedTile, { grain }) }} />
                {showTitles && <div style={pvTitle}>{selectedTile.title}</div>}
              </div>

              <Field label="Title">
                <input defaultValue={selectedTile.title} key={`title-${selectedTile.id}`}
                  onBlur={(e) => patchTile(selectedTile.id, { title: e.target.value })}
                  style={fieldInput} />
              </Field>
              <Field label="Description">
                <textarea defaultValue={selectedTile.description} key={`desc-${selectedTile.id}`}
                  onBlur={(e) => patchTile(selectedTile.id, { description: e.target.value })}
                  placeholder="What is this video about?" style={{ ...fieldInput, minHeight: 62, resize: 'vertical' }} />
              </Field>

              <button onClick={() => patchTile(selectedTile.id, { regenerate: true })} style={generateBtn}>✦ Generate from description</button>

              <div style={recipeBox}>
                <RecipeRow k="Style"><span style={mono}>Auto → {selectedTile.archetype}</span></RecipeRow>
                <RecipeRow k="Palette">
                  <div style={{ display: 'flex', gap: 5 }}>
                    {brand.accents.map((a, i) => (
                      <span key={i} style={{ width: 22, height: 22, borderRadius: 5, background: a, outline: i === (selectedTile.paletteIndex % brand.accents.length) ? '2px solid var(--text)' : 'none', outlineOffset: 1 }} />
                    ))}
                  </div>
                </RecipeRow>
                <RecipeRow k="Seed"><span style={mono}>{(selectedTile.seed >>> 0).toString(16).slice(0, 8)}</span></RecipeRow>
                {selectedTile.archetype === 'duotone' && (
                  <RecipeRow k="Stock"><span style={{ color: 'var(--muted)', fontSize: 12 }}>“{deriveRecipe(selectedTile.title, selectedTile.description, tree.brand).stockQuery}”</span></RecipeRow>
                )}
              </div>

              <Control label="Override style">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                  {ARCHETYPES.map((a) => (
                    <button key={a} onClick={() => patchTile(selectedTile.id, { archetype: a })}
                      style={{ ...miniBtn, ...(selectedTile.archetype === a ? miniBtnOn : {}) }}>
                      {a[0].toUpperCase() + a.slice(1)}
                    </button>
                  ))}
                </div>
              </Control>

              <Control label="Override palette">
                <div style={{ display: 'flex', gap: 7 }}>
                  {brand.accents.map((a, i) => (
                    <button key={i} onClick={() => patchTile(selectedTile.id, { paletteIndex: i })}
                      aria-label={`Palette ${i + 1}`}
                      style={{ width: 30, height: 30, borderRadius: 7, background: a, border: i === (selectedTile.paletteIndex % brand.accents.length) ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </Control>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => patchTile(selectedTile.id, { seed: Math.floor(Math.random() * 4294967295) })} style={{ ...ghostBtn2, flex: 1 }}>⟳ Shuffle</button>
                <button onClick={() => deleteTile(selectedTile.id)} style={{ ...ghostBtn2, flex: 1, color: 'var(--warning)' }}>Delete tile</button>
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

// ── Small helpers ──
function Segmented({ label, options, value, onChange }: {
  label: string; options: Array<{ key: string; label: string; swatch?: string }>; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={tbLabel}>{label}</span>
      <div style={segmented}>
        {options.map((o) => (
          <button key={o.key} onClick={() => onChange(o.key)}
            style={{ ...segBtn, ...(value === o.key ? segBtnOn : {}) }}>
            {o.swatch && <span style={{ width: 18, height: 10, borderRadius: 3, background: o.swatch }} />}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label style={fieldLabel}>{label}</label>{children}</div>;
}
function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}><span style={fieldLabel}>{label}</span>{children}</div>;
}
function RecipeRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ color: 'var(--muted-soft)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, fontWeight: 700, width: 56, flexShrink: 0 }}>{k}</span>
      {children}
    </div>
  );
}

// ── Styles ──
const toolbar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '10px 18px', background: 'var(--surface)', borderBottom: '1px solid var(--line)', flexShrink: 0, flexWrap: 'wrap' };
const iconBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--muted)', fontSize: 15, cursor: 'pointer' };
const titleInput: React.CSSProperties = { background: 'transparent', border: '1px solid transparent', color: 'var(--text-strong)', fontSize: 15, fontWeight: 600, padding: '5px 9px', borderRadius: 8, maxWidth: 260, outline: 'none' };
const statusPill: React.CSSProperties = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 8px' };
const tbLabel: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--muted-soft)', fontWeight: 600 };
const segmented: React.CSSProperties = { display: 'inline-flex', background: 'var(--surface-inset)', border: '1px solid var(--line)', borderRadius: 9, padding: 3, gap: 2 };
const segBtn: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--muted-soft)', fontSize: 12.5, fontWeight: 600, padding: '5px 10px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' };
const segBtnOn: React.CSSProperties = { background: 'var(--surface-3)', color: 'var(--text-strong)' };
const chip: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--muted-soft)', fontSize: 12.5, fontWeight: 600, padding: '7px 11px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' };
const chipOn: React.CSSProperties = { color: 'var(--text-strong)', borderColor: 'var(--accent)', background: 'var(--accent-soft)' };
const exportBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--text)', fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, cursor: 'pointer' };
const catInput: React.CSSProperties = { background: 'transparent', border: '1px solid transparent', color: 'var(--text-strong)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', padding: '3px 8px', borderRadius: 7, outline: 'none', minWidth: 40 };
const faintBtn: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--muted-soft)', fontSize: 12, padding: '5px 8px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' };
const tileCard: React.CSSProperties = { position: 'relative', width: 152, height: 213, borderRadius: 14, overflow: 'hidden', cursor: 'pointer', background: '#222', isolation: 'isolate' };
const tileTitle: React.CSSProperties = { position: 'absolute', top: 12, left: 13, right: 13, zIndex: 2, color: '#fff', fontWeight: 800, fontSize: 14.5, lineHeight: 1.14, letterSpacing: '-0.015em', textShadow: '0 1px 8px rgba(0,0,0,.5)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const tileBadge: React.CSSProperties = { position: 'absolute', bottom: 10, left: 12, zIndex: 2, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,.82)', background: 'rgba(0,0,0,.32)', padding: '3px 7px', borderRadius: 5 };
const addTileBtn: React.CSSProperties = { flex: '0 0 auto', width: 152, height: 213, border: '1.5px dashed var(--line-strong)', borderRadius: 14, background: 'transparent', color: 'var(--muted-soft)', fontSize: 13, fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' };
const addCatBtn: React.CSSProperties = { margin: '6px 24px 0', border: '1.5px dashed var(--line)', background: 'transparent', color: 'var(--muted)', fontSize: 13, fontWeight: 600, padding: 13, borderRadius: 10, width: 'calc(100% - 48px)', cursor: 'pointer' };
const prodNote: React.CSSProperties = { margin: '18px 24px 0', padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, lineHeight: 1.55, color: 'var(--muted)', width: 'calc(100% - 48px)' };
const scrimBg: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 30 };
const inspector: React.CSSProperties = { position: 'fixed', top: 0, right: 0, bottom: 0, width: 372, maxWidth: '92vw', background: 'var(--surface)', borderLeft: '1px solid var(--line)', zIndex: 40, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
const inspHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid var(--line)' };
const inspBody: React.CSSProperties = { padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 };
const previewFrame: React.CSSProperties = { alignSelf: 'center', width: 208, height: 291, borderRadius: 16, overflow: 'hidden', position: 'relative', background: '#222', isolation: 'isolate', boxShadow: 'var(--shadow-md)' };
const pvTitle: React.CSSProperties = { position: 'absolute', top: 16, left: 17, right: 17, zIndex: 2, color: '#fff', fontWeight: 800, fontSize: 18, lineHeight: 1.13, letterSpacing: '-0.02em', textShadow: '0 1px 8px rgba(0,0,0,.5)' };
const fieldLabel: React.CSSProperties = { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted-soft)', fontWeight: 700 };
const fieldInput: React.CSSProperties = { background: 'var(--surface-inset)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 8, padding: '9px 11px', fontSize: 13.5, fontFamily: 'inherit', outline: 'none', width: '100%' };
const generateBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, background: 'var(--accent)', color: '#16130c', border: 0, borderRadius: 9, fontSize: 13.5, fontWeight: 700, padding: 11, cursor: 'pointer' };
const recipeBox: React.CSSProperties = { background: 'var(--surface-inset)', border: '1px solid var(--line)', borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 10 };
const mono: React.CSSProperties = { color: 'var(--text)', fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 };
const miniBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--muted-soft)', fontSize: 11, fontWeight: 600, padding: '8px 4px', borderRadius: 7, cursor: 'pointer' };
const miniBtnOn: React.CSSProperties = { borderColor: 'var(--accent)', color: 'var(--text-strong)', background: 'var(--accent-soft)' };
const ghostBtn2: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, padding: 9, borderRadius: 8, cursor: 'pointer' };
