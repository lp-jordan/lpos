'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PassTree, PlatformTile } from '@/lib/store/platform-pass-store';
import {
  BRANDS, resolveBrand, buildTileBackgroundSVG, deriveRecipe,
  type Brand, type BrandConfig, type TileArchetype, type GrainLevel,
} from '@/lib/platform/tile-background';
import { MediaPicker, type MediaSelection } from './MediaPicker';
import { exportPassTiles } from '@/lib/platform/export-tiles';

const ARCHETYPES: TileArchetype[] = ['gradient', 'geometric', 'duotone', 'hero'];
const GRAINS: GrainLevel[] = ['none', 'subtle', 'film'];

function fmtDur(s: number | null): string {
  if (s == null) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}m ${r}s`;
}

type Drag = { type: 'tile'; id: string; from: string } | { type: 'cat'; id: string } | null;
type Over =
  | { kind: 'tile'; catId: string; beforeId: string | 'end' }
  | { kind: 'cat'; beforeId: string | 'end' }
  | null;

export function PassWorkspace({ passIdOrSlug }: { passIdOrSlug: string }) {
  const router = useRouter();
  const [tree, setTree] = useState<PassTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTitles, setShowTitles] = useState(true);
  const [brandOpen, setBrandOpen] = useState(false);
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<Over>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/platform/passes/${passIdOrSlug}`);
    if (res.ok) {
      const { pass } = await res.json();
      setTree(pass);
      if (pass?.slug && passIdOrSlug !== pass.slug) window.history.replaceState(null, '', `/platform/${pass.slug}`);
    }
    setLoading(false);
  }, [passIdOrSlug]);
  useEffect(() => { load(); }, [load]);

  const applyTile = (t: PlatformTile) => setTree((prev) => prev && ({
    ...prev, categories: prev.categories.map((c) => ({ ...c, tiles: c.tiles.map((x) => (x.id === t.id ? t : x)) })),
  }));

  // ── Pass-level ──
  async function patchPass(body: Record<string, unknown>) {
    if (!tree) return;
    const res = await fetch(`/api/platform/passes/${tree.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) {
      const { pass } = await res.json();
      const slugChanged = !!pass.slug && pass.slug !== tree.slug;
      setTree((p) => p && { ...p, ...pass });
      if (slugChanged) window.history.replaceState(null, '', `/platform/${pass.slug}`);
    }
  }
  async function doExport() {
    if (!tree || exporting) return;
    setExporting(true);
    try {
      const { count } = await exportPassTiles(tree, resolveBrand(tree.brand, tree.brandConfig));
      if (count > 0) patchPass({ status: 'exported' });
      else alert('Add some tiles first — nothing to export yet.');
    } catch (e) {
      alert('Export failed: ' + (e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  function pickBrand(key: string) {
    setTree((p) => p && { ...p, brand: key, brandConfig: null });
    patchPass({ brand: key, brandConfig: null });
  }
  function liveBrandConfig(cfg: BrandConfig) { setTree((p) => p && { ...p, brandConfig: cfg }); }
  function persistBrand() { if (tree) patchPass({ brand: tree.brand, brandConfig: tree.brandConfig }); }
  function resetBrand() { setTree((p) => p && { ...p, brandConfig: null }); patchPass({ brandConfig: null }); }

  // ── Category-level ──
  async function addCategory() {
    if (!tree) return;
    await fetch(`/api/platform/passes/${tree.id}/categories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New category' }),
    });
    load();
  }
  function renameCategory(id: string, title: string) {
    fetch(`/api/platform/categories/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  }
  async function deleteCategory(id: string) { await fetch(`/api/platform/categories/${id}`, { method: 'DELETE' }); load(); }

  // ── Tile-level ──
  async function addTile(categoryId: string) {
    await fetch(`/api/platform/categories/${categoryId}/tiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New tile' }),
    });
    load(); // note: do NOT auto-open the inspector
  }
  async function patchTile(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/platform/tiles/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) applyTile((await res.json()).tile);
  }
  async function deleteTile(id: string) { await fetch(`/api/platform/tiles/${id}`, { method: 'DELETE' }); setSelected(null); load(); }
  async function linkMedia(tileId: string, sel: MediaSelection) {
    const res = await fetch(`/api/platform/tiles/${tileId}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sel) });
    if (res.ok) applyTile((await res.json()).tile);
    setPickerFor(null);
  }
  async function unlinkMedia(tileId: string) {
    const res = await fetch(`/api/platform/tiles/${tileId}/media`, { method: 'DELETE' });
    if (res.ok) applyTile((await res.json()).tile);
  }
  async function uploadTileImage(tileId: string, file: File) {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`/api/platform/tiles/${tileId}/image`, { method: 'POST', body: fd });
    if (res.ok) applyTile((await res.json()).tile);
    else alert((await res.json().catch(() => ({}))).error || 'Upload failed.');
  }
  async function useVideoFrame(tileId: string) {
    const res = await fetch(`/api/platform/tiles/${tileId}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'video' }) });
    if (res.ok) applyTile((await res.json()).tile);
    else alert((await res.json().catch(() => ({}))).error || 'Could not use the video frame.');
  }
  async function removeTileImage(tileId: string) {
    const res = await fetch(`/api/platform/tiles/${tileId}/image`, { method: 'DELETE' });
    if (res.ok) applyTile((await res.json()).tile);
  }
  const tileImageHref = (t: PlatformTile): string | undefined =>
    t.archetype === 'duotone' && t.imageMime ? `/api/platform/tiles/${t.id}/image?v=${encodeURIComponent(t.updatedAt)}` : undefined;

  // ── Drag & drop reorg ──
  function reorderTilesApi(categoryId: string, tileIds: string[]) {
    fetch(`/api/platform/categories/${categoryId}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tileIds }) });
  }
  function reorderCatsApi(categoryIds: string[]) {
    if (!tree) return;
    fetch(`/api/platform/passes/${tree.id}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryIds }) });
  }
  function dropTile(destCatId: string, beforeTileId: string | null) {
    if (!drag || drag.type !== 'tile' || !tree) { setDrag(null); return; }
    const fromCat = drag.from, draggedId = drag.id;
    const cats = tree.categories.map((c) => ({ ...c, tiles: [...c.tiles] }));
    const source = cats.find((c) => c.id === fromCat); const dest = cats.find((c) => c.id === destCatId);
    if (!source || !dest) { setDrag(null); return; }
    const idx = source.tiles.findIndex((t) => t.id === draggedId);
    if (idx < 0) { setDrag(null); return; }
    const [moved] = source.tiles.splice(idx, 1);
    let at = beforeTileId ? dest.tiles.findIndex((t) => t.id === beforeTileId) : dest.tiles.length;
    if (at < 0) at = dest.tiles.length;
    dest.tiles.splice(at, 0, { ...moved, categoryId: destCatId });
    setTree({ ...tree, categories: cats });
    setDrag(null);
    reorderTilesApi(destCatId, dest.tiles.map((t) => t.id));
    if (fromCat !== destCatId) reorderTilesApi(fromCat, source.tiles.map((t) => t.id));
  }
  function dropCat(beforeCatId: string | null) {
    if (!drag || drag.type !== 'cat' || !tree) { setDrag(null); return; }
    const draggedId = drag.id;
    const cats = [...tree.categories];
    const idx = cats.findIndex((c) => c.id === draggedId);
    if (idx < 0) { setDrag(null); return; }
    const [moved] = cats.splice(idx, 1);
    let at = beforeCatId ? cats.findIndex((c) => c.id === beforeCatId) : cats.length;
    if (at < 0) at = cats.length;
    cats.splice(at, 0, moved);
    setTree({ ...tree, categories: cats });
    setDrag(null);
    reorderCatsApi(cats.map((c) => c.id));
  }

  if (loading || !tree) return <div style={{ padding: 48, color: 'var(--muted)' }}>Loading pass…</div>;

  const brand = resolveBrand(tree.brand, tree.brandConfig);
  const selectedTile: PlatformTile | null = selected
    ? tree.categories.flatMap((c) => c.tiles).find((t) => t.id === selected) ?? null : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header: large pass name on top, lighter data row below */}
      <div style={headerWrap}>
        <button onClick={() => router.push('/platform')} style={breadcrumb}>‹ Platform</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            defaultValue={tree.title}
            onBlur={(e) => patchPass({ title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={passNameInput} aria-label="Pass title"
          />
          <button onClick={() => setBrandOpen(true)} style={brandBtn}>
            <span style={brandLabel}>Brand</span>
            <span style={{ width: 15, height: 15, borderRadius: 4, background: brand.swatch }} />
            {brand.name}{tree.brandConfig ? ' *' : ''}
            <span style={{ color: 'var(--muted-soft)', fontSize: 11 }}>▾</span>
          </button>
          <button onClick={() => setShowTitles((s) => !s)} style={{ ...chip, ...(showTitles ? chipOn : {}) }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: showTitles ? 'var(--accent)' : 'var(--muted-soft)' }} /> Platform text
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={doExport} disabled={exporting} style={{ ...exportBtn, opacity: exporting ? 0.6 : 1 }} title="Rasterise every tile to a labelled PNG and download a zip for LeaderPass admin">{exporting ? 'Exporting…' : 'Export ▸'}</button>
        </div>
      </div>

      {/* Board */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0 60px' }}>
        <style>{`@keyframes pfGlow{0%,100%{opacity:.6}50%{opacity:1}}@media(prefers-reduced-motion:reduce){[data-pf-anim]{animation:none!important}}`}</style>
        {tree.categories.map((cat, ci) => (
          <div key={cat.id}>
            {over?.kind === 'cat' && over.beforeId === cat.id && <div data-pf-anim style={dropLineH} />}
            <section
              onDragOver={(e) => {
                if (drag?.type !== 'cat') return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setOver({ kind: 'cat', beforeId: e.clientY < r.top + r.height / 2 ? cat.id : (tree.categories[ci + 1]?.id ?? 'end') });
              }}
              onDrop={() => { if (over?.kind === 'cat') dropCat(over.beforeId === 'end' ? null : over.beforeId); }}
              style={{ padding: '14px 24px 4px', opacity: drag?.type === 'cat' && drag.id === cat.id ? 0.4 : 1, transition: 'opacity .12s' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span draggable
                  onDragStart={(e) => { setDrag({ type: 'cat', id: cat.id }); e.dataTransfer.setData('text/plain', cat.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { setDrag(null); setOver(null); }}
                  style={dragHandle} title="Drag to reorder category">⠿</span>
                <input
                  defaultValue={cat.title}
                  onBlur={(e) => renameCategory(cat.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  style={catInput} aria-label="Category name"
                />
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 11, color: 'var(--muted-soft)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    {cat.tiles.length} {cat.tiles.length === 1 ? 'tile' : 'tiles'}
                  </span>
                  <button onClick={() => deleteCategory(cat.id)} style={faintBtn}>Delete</button>
                </div>
              </div>

              <div
                onDragOver={(e) => { if (drag?.type === 'tile' && e.target === e.currentTarget) { e.preventDefault(); setOver({ kind: 'tile', catId: cat.id, beforeId: 'end' }); } }}
                onDrop={() => { if (over?.kind === 'tile') dropTile(over.catId, over.beforeId === 'end' ? null : over.beforeId); }}
                style={{ display: 'flex', gap: 14, overflowX: 'auto', padding: '4px 2px 12px', minHeight: 60 }}
              >
                {cat.tiles.map((t, ti) => {
                  const isDragged = drag?.type === 'tile' && drag.id === t.id;
                  return (
                    <Fragment key={t.id}>
                      {over?.kind === 'tile' && over.catId === cat.id && over.beforeId === t.id && <div data-pf-anim style={dropLineV} />}
                      <div
                        onDragOver={(e) => {
                          if (drag?.type !== 'tile') return;
                          e.preventDefault(); e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          setOver({ kind: 'tile', catId: cat.id, beforeId: e.clientX < r.left + r.width / 2 ? t.id : (cat.tiles[ti + 1]?.id ?? 'end') });
                        }}
                        style={{ flex: '0 0 auto', width: 152, display: 'flex', flexDirection: 'column', gap: 6, opacity: isDragged ? 0.35 : 1, transform: isDragged ? 'scale(0.95)' : 'none', transition: 'opacity .12s, transform .12s' }}
                      >
                        <div
                          draggable
                          onDragStart={(e) => { setDrag({ type: 'tile', id: t.id, from: cat.id }); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; }}
                          onDragEnd={() => { setDrag(null); setOver(null); }}
                          onClick={() => setSelected(t.id)}
                          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: Math.min(e.clientX, window.innerWidth - 192), y: Math.min(e.clientY, window.innerHeight - 250), id: t.id }); }}
                          style={{ ...tileCard, boxShadow: selected === t.id ? '0 0 0 2.5px var(--accent)' : '0 2px 8px rgba(0,0,0,.3)' }}
                        >
                          <div style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: buildTileBackgroundSVG(brand, t, { grain: t.grain, imageHref: tileImageHref(t) }) }} />
                          {showTitles && <div style={tileTitle}>{t.title}</div>}
                          <div style={tileBadge}>{t.archetype}</div>
                        </div>
                        <input
                          key={`name-${t.id}-${t.title}`} defaultValue={t.title}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => { if (e.target.value !== t.title) patchTile(t.id, { title: e.target.value }); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          style={tileNameInput} aria-label="Tile name"
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted-soft)', padding: '0 2px', overflow: 'hidden' }}>
                          {(t.mediaAssetId || t.linkUrl)
                            ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.mediaKind === 'link' ? '🔗' : '▤'} {t.mediaTitle ?? t.mediaKind ?? 'media'}{t.durationSec != null ? ` · ${fmtDur(t.durationSec)}` : ''}</span>
                            : <span>○ not linked</span>}
                        </div>
                      </div>
                    </Fragment>
                  );
                })}
                {over?.kind === 'tile' && over.catId === cat.id && over.beforeId === 'end' && <div data-pf-anim style={dropLineV} />}
                <button
                  onClick={() => addTile(cat.id)}
                  onDragOver={(e) => { if (drag?.type === 'tile') { e.preventDefault(); setOver({ kind: 'tile', catId: cat.id, beforeId: 'end' }); } }}
                  style={addTileBtn}><span style={{ fontSize: 24, fontWeight: 300 }}>+</span>Add tile</button>
              </div>
            </section>
          </div>
        ))}
        {over?.kind === 'cat' && over.beforeId === 'end' && <div data-pf-anim style={dropLineH} />}
        <button onClick={addCategory} style={addCatBtn}>+  New category</button>
      </div>

      {/* Brand modal */}
      {brandOpen && (
        <BrandModal
          brand={brand} customised={!!tree.brandConfig}
          onPick={pickBrand} onLive={liveBrandConfig} onPersist={persistBrand} onReset={resetBrand}
          onClose={() => setBrandOpen(false)}
        />
      )}

      {/* Media picker */}
      {pickerFor && <MediaPicker onPick={(sel) => linkMedia(pickerFor, sel)} onClose={() => setPickerFor(null)} />}

      {/* Tile right-click menu */}
      {menu && (
        <>
          <div onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{ ...ctxMenu, left: menu.x, top: menu.y }}>
            <CtxItem onClick={() => { setSelected(menu.id); setMenu(null); }}>Edit…</CtxItem>
            <CtxItem onClick={() => { patchTile(menu.id, { regenerate: true }); setMenu(null); }}>Regenerate art</CtxItem>
            <CtxItem onClick={() => { patchTile(menu.id, { seed: Math.floor(Math.random() * 4294967295) }); setMenu(null); }}>Shuffle seed</CtxItem>
            <CtxItem onClick={() => { setPickerFor(menu.id); setMenu(null); }}>Link media…</CtxItem>
            <div style={{ height: 1, background: 'var(--line)', margin: '4px 6px' }} />
            <CtxItem danger onClick={() => { deleteTile(menu.id); setMenu(null); }}>Delete tile</CtxItem>
          </div>
        </>
      )}

      {/* Tile inspector */}
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
                <div style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: buildTileBackgroundSVG(brand, selectedTile, { grain: selectedTile.grain, imageHref: tileImageHref(selectedTile) }) }} />
                {showTitles && <div style={pvTitle}>{selectedTile.title}</div>}
              </div>

              <Field label="Title">
                <input key={`title-${selectedTile.id}`} defaultValue={selectedTile.title}
                  onBlur={(e) => patchTile(selectedTile.id, { title: e.target.value })} style={fieldInput} />
              </Field>
              <Field label="Description">
                <textarea key={`desc-${selectedTile.id}`} defaultValue={selectedTile.description}
                  onBlur={(e) => patchTile(selectedTile.id, { description: e.target.value })}
                  placeholder="What is this video about?" style={{ ...fieldInput, minHeight: 62, resize: 'vertical' }} />
              </Field>

              <Control label="Linked media">
                {(selectedTile.mediaAssetId || selectedTile.linkUrl) ? (
                  <div style={linkedRow}>
                    {selectedTile.mediaThumbUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={selectedTile.mediaThumbUrl} alt="" style={{ width: 52, height: 30, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                      : <span style={{ width: 52, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-3)', borderRadius: 4, color: 'var(--muted-soft)', flexShrink: 0 }}>{selectedTile.mediaKind === 'link' ? '🔗' : '▤'}</span>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedTile.mediaTitle ?? selectedTile.linkUrl}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted-soft)' }}>{selectedTile.mediaKind}{selectedTile.durationSec != null ? ` · ${fmtDur(selectedTile.durationSec)}` : ''}</div>
                    </div>
                    <button onClick={() => setPickerFor(selectedTile.id)} style={faintBtn}>Change</button>
                    <button onClick={() => unlinkMedia(selectedTile.id)} style={faintBtn}>Unlink</button>
                  </div>
                ) : (
                  <button onClick={() => setPickerFor(selectedTile.id)} style={ghostBtn2}>+ Link media</button>
                )}
              </Control>

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
                  <RecipeRow k="Stock"><span style={{ color: 'var(--muted)', fontSize: 12 }}>“{deriveRecipe(selectedTile.title, selectedTile.description, brand).stockQuery}”</span></RecipeRow>
                )}
              </div>

              {selectedTile.archetype === 'duotone' && (
                <Control label="Source image">
                  {selectedTile.imageMime ? (
                    <div style={linkedRow}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={tileImageHref(selectedTile)} alt="" style={{ width: 52, height: 30, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--muted)' }}>Real image · duotoned on brand</div>
                      <label style={{ ...faintBtn, cursor: 'pointer' }}>Replace
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTileImage(selectedTile.id, f); e.target.value = ''; }} />
                      </label>
                      <button onClick={() => removeTileImage(selectedTile.id)} style={faintBtn}>Remove</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <label style={{ ...ghostBtn2, flex: 1, textAlign: 'center', cursor: 'pointer' }}>Upload image
                          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTileImage(selectedTile.id, f); e.target.value = ''; }} />
                        </label>
                        {selectedTile.mediaAssetId && <button onClick={() => useVideoFrame(selectedTile.id)} style={{ ...ghostBtn2, flex: 1 }}>Use video frame</button>}
                      </div>
                      <span style={{ fontSize: 11.5, color: 'var(--muted-soft)', lineHeight: 1.4 }}>No image → procedural stand-in. Add one and it’s auto-duotoned on brand.</span>
                    </div>
                  )}
                </Control>
              )}

              <Control label="Override style">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                  {ARCHETYPES.map((a) => (
                    <button key={a} onClick={() => patchTile(selectedTile.id, { archetype: a })} style={{ ...miniBtn, ...(selectedTile.archetype === a ? miniBtnOn : {}) }}>
                      {a[0].toUpperCase() + a.slice(1)}
                    </button>
                  ))}
                </div>
              </Control>

              <Control label="Override palette">
                <div style={{ display: 'flex', gap: 7 }}>
                  {brand.accents.map((a, i) => (
                    <button key={i} onClick={() => patchTile(selectedTile.id, { paletteIndex: i })} aria-label={`Palette ${i + 1}`}
                      style={{ width: 30, height: 30, borderRadius: 7, background: a, border: i === (selectedTile.paletteIndex % brand.accents.length) ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </Control>

              <Control label="Grain">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
                  {GRAINS.map((g) => (
                    <button key={g} onClick={() => patchTile(selectedTile.id, { grain: g })} style={{ ...miniBtn, ...(selectedTile.grain === g ? miniBtnOn : {}) }}>
                      {g[0].toUpperCase() + g.slice(1)}
                    </button>
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

// ── Brand modal ──
function BrandModal({ brand, customised, onPick, onLive, onPersist, onReset, onClose }: {
  brand: Brand; customised: boolean;
  onPick: (key: string) => void; onLive: (cfg: BrandConfig) => void; onPersist: () => void; onReset: () => void; onClose: () => void;
}) {
  const snapshot = (override: Partial<BrandConfig>): BrandConfig => ({
    name: brand.name, accents: [...brand.accents], duoDark: brand.duoDark, duoLight: brand.duoLight, gold: brand.gold, ...override,
  });
  const setAccent = (i: number, val: string) => { const accents = [...brand.accents]; accents[i] = val; onLive(snapshot({ accents })); };

  return (
    <>
      <div onClick={onClose} style={scrimBg} />
      <div style={brandModal}>
        <div style={inspHead}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)' }}>Brand</span>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        <div style={{ ...inspBody, gap: 20 }}>
          <div>
            <div style={fieldLabel}>Presets</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, marginTop: 8 }}>
              {Object.values(BRANDS).map((b) => (
                <button key={b.key} onClick={() => onPick(b.key)}
                  style={{ ...presetCard, borderColor: !customised && b.key === brand.key ? 'var(--accent)' : 'var(--line)' }}>
                  <div style={{ display: 'flex', gap: 3 }}>{b.accents.map((a, i) => <span key={i} style={{ width: 16, height: 16, borderRadius: 3, background: a }} />)}</div>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{b.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={fieldLabel}>Customize{customised ? ' *' : ''}</span>
              {customised && <button onClick={onReset} style={faintBtn}>Reset to preset</button>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {brand.accents.map((a, i) => (
                <ColorSwatch key={i} label={`Accent ${i + 1}`} value={a} onChange={(v) => setAccent(i, v)} onCommit={onPersist} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <ColorSwatch label="Shadow" value={brand.duoDark} onChange={(v) => onLive(snapshot({ duoDark: v }))} onCommit={onPersist} />
              <ColorSwatch label="Highlight" value={brand.duoLight} onChange={(v) => onLive(snapshot({ duoLight: v }))} onCommit={onPersist} />
              <ColorSwatch label="Line" value={brand.gold} onChange={(v) => onLive(snapshot({ gold: v }))} onCommit={onPersist} />
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--muted-soft)', marginTop: 12, lineHeight: 1.5 }}>
              Edits apply to this pass only. Tiles recolour live; changes save when you release the picker.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function ColorSwatch({ label, value, onChange, onCommit }: { label: string; value: string; onChange: (v: string) => void; onCommit: () => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }} title={label}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} onBlur={onCommit}
        style={{ width: 40, height: 34, border: '1px solid var(--line)', borderRadius: 8, background: 'transparent', cursor: 'pointer', padding: 2 }} />
      <span style={{ fontSize: 9.5, color: 'var(--muted-soft)' }}>{label}</span>
    </label>
  );
}

function CtxItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...ctxItem, background: hover ? 'var(--surface-hover)' : 'transparent', color: danger ? 'var(--warning)' : 'var(--text)' }}>
      {children}
    </button>
  );
}

// ── Small helpers ──
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
const headerWrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 24px 12px', background: 'transparent', borderBottom: '1px solid var(--line)', flexShrink: 0 };
const breadcrumb: React.CSSProperties = { alignSelf: 'flex-start', background: 'transparent', border: 0, color: 'var(--muted-soft)', fontSize: 12, fontWeight: 600, padding: '2px 4px', cursor: 'pointer', letterSpacing: '0.01em' };
const iconBtn: React.CSSProperties = { width: 32, height: 32, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--muted)', fontSize: 15, cursor: 'pointer', flexShrink: 0 };
const passNameInput: React.CSSProperties = { background: 'transparent', border: '1px solid transparent', color: 'var(--text-strong)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', padding: '3px 8px', borderRadius: 8, outline: 'none', flex: '0 1 auto', minWidth: 120 };
const brandLabel: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--muted-soft)', fontWeight: 700 };
const brandBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 8, cursor: 'pointer' };
const chip: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--muted-soft)', fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' };
const chipOn: React.CSSProperties = { color: 'var(--text-strong)', borderColor: 'var(--accent)', background: 'var(--accent-soft)' };
const exportBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--text)', fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, cursor: 'pointer' };
const dragHandle: React.CSSProperties = { cursor: 'grab', color: 'var(--muted-soft)', fontSize: 15, userSelect: 'none', padding: '0 2px' };
const dropLineV: React.CSSProperties = { flex: '0 0 auto', width: 4, alignSelf: 'stretch', borderRadius: 3, background: 'var(--accent)', boxShadow: '0 0 10px 2px var(--accent-soft)', animation: 'pfGlow 1s ease-in-out infinite' };
const dropLineH: React.CSSProperties = { height: 4, borderRadius: 3, background: 'var(--accent)', boxShadow: '0 0 10px 2px var(--accent-soft)', margin: '2px 24px', animation: 'pfGlow 1s ease-in-out infinite' };
const catInput: React.CSSProperties = { background: 'transparent', border: '1px solid transparent', color: 'var(--text-strong)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', padding: '3px 8px', borderRadius: 7, outline: 'none', minWidth: 40 };
const faintBtn: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--muted-soft)', fontSize: 12, padding: '5px 8px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' };
const tileCard: React.CSSProperties = { position: 'relative', width: 152, height: 213, borderRadius: 14, overflow: 'hidden', cursor: 'pointer', background: '#222', isolation: 'isolate' };
const tileTitle: React.CSSProperties = { position: 'absolute', top: 12, left: 13, right: 13, zIndex: 2, color: '#fff', fontWeight: 800, fontSize: 14.5, lineHeight: 1.14, letterSpacing: '-0.015em', textShadow: '0 1px 8px rgba(0,0,0,.5)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
const tileBadge: React.CSSProperties = { position: 'absolute', bottom: 10, left: 12, zIndex: 2, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,.82)', background: 'rgba(0,0,0,.32)', padding: '3px 7px', borderRadius: 5 };
const addTileBtn: React.CSSProperties = { flex: '0 0 auto', width: 152, height: 213, border: '1.5px dashed var(--line-strong)', borderRadius: 14, background: 'transparent', color: 'var(--muted-soft)', fontSize: 13, fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' };
const addCatBtn: React.CSSProperties = { margin: '6px 24px 0', border: '1.5px dashed var(--line)', background: 'transparent', color: 'var(--muted)', fontSize: 13, fontWeight: 600, padding: 13, borderRadius: 10, width: 'calc(100% - 48px)', cursor: 'pointer' };
const scrimBg: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 30 };
const inspector: React.CSSProperties = { position: 'fixed', top: 0, right: 0, bottom: 0, width: 372, maxWidth: '92vw', background: 'var(--surface)', borderLeft: '1px solid var(--line)', zIndex: 40, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
const brandModal: React.CSSProperties = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 420, maxWidth: '94vw', maxHeight: '86vh', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, zIndex: 40, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
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
const ghostBtn2: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, padding: '8px 12px', borderRadius: 8, cursor: 'pointer' };
const presetCard: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-inset)', cursor: 'pointer' };
const linkedRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-inset)', border: '1px solid var(--line)', borderRadius: 8, padding: 8 };
const tileNameInput: React.CSSProperties = { width: 152, background: 'var(--surface-inset)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, padding: '4px 7px', borderRadius: 6, outline: 'none' };
const ctxMenu: React.CSSProperties = { position: 'fixed', zIndex: 61, minWidth: 176, background: 'var(--surface-2)', border: '1px solid var(--line-strong)', borderRadius: 10, padding: 5, display: 'flex', flexDirection: 'column', gap: 1, boxShadow: 'var(--shadow-lg)' };
const ctxItem: React.CSSProperties = { textAlign: 'left', background: 'transparent', border: 0, color: 'var(--text)', fontSize: 13, fontWeight: 500, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', width: '100%' };
