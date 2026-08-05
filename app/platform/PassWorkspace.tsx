'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PassTree, PlatformPass, PlatformTile, BrandPreset } from '@/lib/store/platform-pass-store';
import {
  BRANDS, resolveBrand, buildTileBackgroundSVG,
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
  | { kind: 'tile'; catId: string; beforeId: string | 'end'; x: number }
  | { kind: 'cat'; beforeId: string | 'end' }
  | null;

export function PassWorkspace({ passIdOrSlug }: { passIdOrSlug: string }) {
  const router = useRouter();
  const [tree, setTree] = useState<PassTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTitles, setShowTitles] = useState(true);
  const [brandOpen, setBrandOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<Over>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [editingTile, setEditingTile] = useState<string | null>(null);
  const [genFor, setGenFor] = useState<string | null>(null); // tile whose image is generating
  const [promptDraft, setPromptDraft] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);

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

  // Reset the image-prompt editor whenever a different tile is opened, prefilling
  // from that tile's stored prompt (if it was generated before).
  useEffect(() => {
    const t = selected ? tree?.categories.flatMap((c) => c.tiles).find((x) => x.id === selected) : null;
    setPromptDraft(t?.imagePrompt ?? '');
    setShowPrompt(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const applyTile = (t: PlatformTile) => setTree((prev) => prev && ({
    ...prev, categories: prev.categories.map((c) => ({ ...c, tiles: c.tiles.map((x) => (x.id === t.id ? t : x)) })),
  }));
  const updateLocalTile = (id: string, patch: Partial<PlatformTile>) => setTree((prev) => prev && ({
    ...prev, categories: prev.categories.map((c) => ({ ...c, tiles: c.tiles.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
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
    if (sel.kind === 'video') setTree((p) => p && { ...p, defaultProjectId: sel.projectId }); // remember for the next tile this session
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
  async function generateTileImage(tileId: string, prompt?: string) {
    if (genFor) return;
    setGenFor(tileId);
    try {
      const res = await fetch(`/api/platform/tiles/${tileId}/generate-image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prompt ? { prompt } : {}),
      });
      if (res.ok) {
        const { tile, prompt: used } = await res.json();
        applyTile(tile); // updatedAt bumps → the ?v= cache-buster refreshes the preview
        setPromptDraft(used ?? '');
      } else {
        alert((await res.json().catch(() => ({}))).error || 'Generation failed.');
      }
    } finally {
      setGenFor(null);
    }
  }
  const canHaveImage = (t: PlatformTile) => t.archetype === 'duotone' || t.archetype === 'geometric';
  const tileImageHref = (t: PlatformTile): string | undefined =>
    canHaveImage(t) && t.imageMime ? `/api/platform/tiles/${t.id}/image?v=${encodeURIComponent(t.updatedAt)}` : undefined;
  const tileSvg = (t: PlatformTile) => buildTileBackgroundSVG(brand, t, { grain: t.grain, imageHref: tileImageHref(t), duoShadow: t.duoShadow, duoLight: t.duoLight });

  // ── Drag & drop reorg ──
  function reorderTilesApi(categoryId: string, tileIds: string[]) {
    fetch(`/api/platform/categories/${categoryId}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tileIds }) });
  }
  function reorderCatsApi(categoryIds: string[]) {
    if (!tree) return;
    fetch(`/api/platform/passes/${tree.id}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryIds }) });
  }
  // Guarded setters — only re-render when the drop target actually changes (kills indicator jitter).
  function setOverTile(catId: string, beforeId: string | 'end', x: number) {
    setOver((prev) => (prev && prev.kind === 'tile' && prev.catId === catId && prev.beforeId === beforeId && prev.x === x) ? prev : { kind: 'tile', catId, beforeId, x });
  }
  function setOverCat(beforeId: string | 'end') {
    setOver((prev) => (prev && prev.kind === 'cat' && prev.beforeId === beforeId) ? prev : { kind: 'cat', beforeId });
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
          <button onClick={() => setSheetOpen(true)} style={{ ...chip, ...(tree.sheetId ? chipOn : {}) }}
            title={tree.sheetId ? `Pass map connected: ${tree.sheetTabTitle}` : 'Connect a Google Sheet pass map'}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: tree.sheetId ? 'var(--accent)' : 'var(--muted-soft)' }} />
            {tree.sheetId ? `Pass map: ${tree.sheetTabTitle}` : 'Connect pass map'}
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
                setOverCat(e.clientY < r.top + r.height / 2 ? cat.id : (tree.categories[ci + 1]?.id ?? 'end'));
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
                onDragOver={(e) => { if (drag?.type === 'tile' && e.target === e.currentTarget) { e.preventDefault(); const btn = e.currentTarget.lastElementChild as HTMLElement | null; setOverTile(cat.id, 'end', btn ? btn.offsetLeft - 7 : 4); } }}
                onDrop={() => { if (over?.kind === 'tile') dropTile(over.catId, over.beforeId === 'end' ? null : over.beforeId); }}
                style={{ position: 'relative', display: 'flex', gap: 14, overflowX: 'auto', padding: '4px 2px 12px', minHeight: 60 }}
              >
                {over?.kind === 'tile' && over.catId === cat.id && <div data-pf-anim style={{ ...dropLineAbs, left: over.x }} />}
                {cat.tiles.map((t, ti) => {
                  const isDragged = drag?.type === 'tile' && drag.id === t.id;
                  return (
                      <div
                        key={t.id}
                        onDragOver={(e) => {
                          if (drag?.type !== 'tile') return;
                          e.preventDefault(); e.stopPropagation();
                          const el = e.currentTarget as HTMLElement;
                          const r = el.getBoundingClientRect();
                          const before = e.clientX < r.left + r.width / 2;
                          setOverTile(cat.id, before ? t.id : (cat.tiles[ti + 1]?.id ?? 'end'), before ? el.offsetLeft - 7 : el.offsetLeft + el.offsetWidth + 7);
                        }}
                        style={{ flex: '0 0 auto', width: 152, display: 'flex', flexDirection: 'column', gap: 6, opacity: isDragged ? 0.4 : 1, transform: isDragged ? 'scale(0.92)' : 'none', transition: 'opacity .14s ease, transform .14s ease' }}
                      >
                        <div
                          draggable={editingTile !== t.id}
                          onDragStart={(e) => { setDrag({ type: 'tile', id: t.id, from: cat.id }); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; }}
                          onDragEnd={() => { setDrag(null); setOver(null); }}
                          onClick={() => setSelected(t.id)}
                          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: Math.min(e.clientX, window.innerWidth - 192), y: Math.min(e.clientY, window.innerHeight - 250), id: t.id }); }}
                          style={{ ...tileCard, boxShadow: selected === t.id ? '0 0 0 2.5px var(--accent)' : '0 2px 8px rgba(0,0,0,.3)' }}
                        >
                          <div style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: tileSvg(t) }} />
                          {showTitles && (editingTile === t.id ? (
                            <textarea
                              autoFocus defaultValue={t.title}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.title) patchTile(t.id, { title: e.target.value }); setEditingTile(null); }}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } else if (e.key === 'Escape') { setEditingTile(null); } }}
                              style={tileTitleEdit}
                            />
                          ) : (
                            <div style={tileTitle} onClick={(e) => { e.stopPropagation(); setEditingTile(t.id); }} title="Click to rename">{t.title}</div>
                          ))}
                          <div style={tileBadge}>{t.archetype}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted-soft)', padding: '0 2px', overflow: 'hidden' }}>
                          {(t.mediaAssetId || t.linkUrl)
                            ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.mediaKind === 'link' ? '🔗' : '▤'} {t.mediaTitle ?? t.mediaKind ?? 'media'}{t.durationSec != null ? ` · ${fmtDur(t.durationSec)}` : ''}</span>
                            : <span>○ not linked</span>}
                        </div>
                      </div>
                  );
                })}
                <button
                  onClick={() => addTile(cat.id)}
                  onDragOver={(e) => { if (drag?.type === 'tile') { e.preventDefault(); const el = e.currentTarget as HTMLElement; setOverTile(cat.id, 'end', el.offsetLeft - 7); } }}
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

      {/* Pass-map (Google Sheet) connect modal */}
      {sheetOpen && (
        <SheetModal
          pass={tree}
          onConnected={(pass) => setTree((p) => p && { ...p, ...pass })}
          onDisconnected={() => setTree((p) => p && { ...p, sheetId: null, sheetUrl: null, sheetTabGid: null, sheetTabTitle: null, sheetTabCount: null, sheetRowCount: null, sheetConnectedAt: null })}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {/* Media picker */}
      {pickerFor && <MediaPicker onPick={(sel) => linkMedia(pickerFor, sel)} onClose={() => setPickerFor(null)} defaultProjectId={tree.defaultProjectId} />}

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
                <div style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: tileSvg(selectedTile) }} />
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedTile.mediaTitle ?? selectedTile.linkUrl}</span>
                        {selectedTile.mediaVersion != null && <span style={versionPill} title="Linked media version">v{selectedTile.mediaVersion}</span>}
                      </div>
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

              {canHaveImage(selectedTile) && (() => {
                const generating = genFor === selectedTile.id;
                const isGeneric = selectedTile.archetype === 'geometric';
                const promptEditor = (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button onClick={() => setShowPrompt((s) => !s)} style={{ ...faintBtn, alignSelf: 'flex-start', padding: '2px 2px' }}>
                      {showPrompt ? '▾ Prompt' : '▸ Edit prompt'}
                    </button>
                    {showPrompt && (
                      <textarea
                        value={promptDraft}
                        onChange={(e) => setPromptDraft(e.target.value)}
                        placeholder="Auto-built from the title + description. Type here to steer the generated image."
                        style={{ ...fieldInput, minHeight: 66, resize: 'vertical', fontSize: 12.5, lineHeight: 1.4 }}
                      />
                    )}
                  </div>
                );
                return (
                  <Control label={isGeneric ? 'Background image' : 'Source image'}>
                    {selectedTile.imageMime ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={linkedRow}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={tileImageHref(selectedTile)} alt="" style={{ width: 52, height: 30, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--muted)' }}>
                            {selectedTile.imageSource === 'generated' ? (isGeneric ? 'Generated · behind the shapes' : 'Generated · duotoned on brand')
                              : selectedTile.imageSource === 'poster' ? 'Video frame · duotoned on brand'
                              : isGeneric ? 'Real image · behind the shapes' : 'Real image · duotoned on brand'}
                          </div>
                          <label style={{ ...faintBtn, cursor: 'pointer' }}>Replace
                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTileImage(selectedTile.id, f); e.target.value = ''; }} />
                          </label>
                          <button onClick={() => removeTileImage(selectedTile.id)} style={faintBtn}>Remove</button>
                        </div>
                        <button onClick={() => generateTileImage(selectedTile.id, promptDraft.trim() || undefined)} disabled={generating} style={{ ...ghostBtn2, opacity: generating ? 0.6 : 1 }}>
                          {generating ? 'Generating…' : '✦ Regenerate'}
                        </button>
                        {promptEditor}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <button onClick={() => generateTileImage(selectedTile.id, promptDraft.trim() || undefined)} disabled={generating} style={{ ...generateImgBtn, opacity: generating ? 0.7 : 1 }}>
                          {generating ? 'Generating…' : '✦ Generate image'}
                        </button>
                        {promptEditor}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <label style={{ ...ghostBtn2, flex: 1, textAlign: 'center', cursor: 'pointer' }}>Upload
                            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTileImage(selectedTile.id, f); e.target.value = ''; }} />
                          </label>
                          {selectedTile.mediaAssetId && <button onClick={() => useVideoFrame(selectedTile.id)} style={{ ...ghostBtn2, flex: 1 }}>Use video frame</button>}
                        </div>
                        <span style={{ fontSize: 11.5, color: 'var(--muted-soft)', lineHeight: 1.4 }}>
                          {isGeneric ? 'Optional — sits behind the shapes. None → shapes only.' : 'None → procedural stand-in.'} Generated images are duotoned on brand (currently a placeholder until the image API is wired).
                        </span>
                      </div>
                    )}
                  </Control>
                );
              })()}

              {selectedTile.archetype === 'duotone' && (
                <Control label="Duotone colours">
                  <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
                    <ColorField label="Shadow" value={selectedTile.duoShadow ?? brand.duoDark}
                      onInput={(v) => updateLocalTile(selectedTile.id, { duoShadow: v })}
                      onCommit={() => patchTile(selectedTile.id, { duoShadow: selectedTile.duoShadow ?? brand.duoDark })} />
                    <ColorField label="Highlight" value={selectedTile.duoLight ?? brand.accents[selectedTile.paletteIndex % brand.accents.length]}
                      onInput={(v) => updateLocalTile(selectedTile.id, { duoLight: v })}
                      onCommit={() => patchTile(selectedTile.id, { duoLight: selectedTile.duoLight ?? brand.accents[selectedTile.paletteIndex % brand.accents.length] })} />
                    {(selectedTile.duoShadow || selectedTile.duoLight) && <button onClick={() => patchTile(selectedTile.id, { duoShadow: null, duoLight: null })} style={faintBtn}>Reset</button>}
                  </div>
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
  const [presets, setPresets] = useState<BrandPreset[]>([]);
  const loadPresets = () => fetch('/api/platform/brands').then((r) => r.ok ? r.json() : { presets: [] }).then((d) => setPresets(d.presets ?? []));
  useEffect(() => { loadPresets(); }, []);

  const snapshot = (override: Partial<BrandConfig>): BrandConfig => ({
    name: brand.name, accents: [...brand.accents], duoDark: brand.duoDark, duoLight: brand.duoLight, gold: brand.gold, ...override,
  });
  const setAccent = (i: number, val: string) => { const accents = [...brand.accents]; accents[i] = val; onLive(snapshot({ accents })); };

  async function addPreset() {
    const name = window.prompt('Save current colours as a preset. Name:', brand.name);
    if (!name?.trim()) return;
    const res = await fetch('/api/platform/brands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), config: snapshot({}) }) });
    if (res.ok) loadPresets();
  }
  async function deletePreset(id: string) { await fetch(`/api/platform/brands/${id}`, { method: 'DELETE' }); loadPresets(); }

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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={fieldLabel}>Presets</span>
              <button onClick={addPreset} style={faintBtn}>+ Add preset</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, marginTop: 8 }}>
              {Object.values(BRANDS).map((b) => (
                <button key={b.key} onClick={() => onPick(b.key)}
                  style={{ ...presetCard, borderColor: !customised && b.key === brand.key ? 'var(--accent)' : 'var(--line)' }}>
                  <div style={{ display: 'flex', gap: 3 }}>{b.accents.map((a, i) => <span key={i} style={{ width: 16, height: 16, borderRadius: 3, background: a }} />)}</div>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{b.name}</span>
                </button>
              ))}
              {presets.map((p) => (
                <div key={p.id} onClick={() => { onLive(p.config); onPersist(); }} style={{ ...presetCard, position: 'relative' }}>
                  <div style={{ display: 'flex', gap: 3 }}>{(p.config.accents ?? []).map((a, i) => <span key={i} style={{ width: 16, height: 16, borderRadius: 3, background: a }} />)}</div>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{p.config.name ?? p.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); deletePreset(p.id); }} title="Delete preset"
                    style={{ position: 'absolute', top: 5, right: 6, border: 0, background: 'transparent', color: 'var(--muted-soft)', cursor: 'pointer', fontSize: 12 }}>✕</button>
                </div>
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
          </div>
        </div>
      </div>
    </>
  );
}

function ColorField({ label, value, onInput, onCommit }: { label: string; value: string; onInput: (v: string) => void; onCommit: () => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
      <input type="color" value={value} onChange={(e) => onInput(e.target.value)} onBlur={onCommit}
        style={{ width: 44, height: 34, border: '1px solid var(--line)', borderRadius: 8, background: 'transparent', cursor: 'pointer', padding: 2 }} />
      <span style={{ fontSize: 9.5, color: 'var(--muted-soft)' }}>{label}</span>
    </label>
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

// ── Pass-map (Google Sheet) connect modal ──
type SheetTab = { title: string; gid: number; rowCount: number; colCount: number };

function SheetModal({ pass, onConnected, onDisconnected, onClose }: {
  pass: PassTree;
  onConnected: (pass: PlatformPass) => void;
  onDisconnected: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(pass.sheetUrl ?? '');
  const [tabs, setTabs] = useState<SheetTab[] | null>(null);
  const [workbookTitle, setWorkbookTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function loadTabs() {
    if (!url.trim()) return;
    setBusy(true); setError(null); setWarning(null);
    try {
      const res = await fetch(`/api/platform/passes/${pass.id}/sheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Could not read that sheet.'); return; }
      setWorkbookTitle(data.spreadsheetTitle ?? '');
      setTabs(data.tabs ?? []);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function connectTab(tab: SheetTab) {
    setBusy(true); setError(null); setWarning(null);
    try {
      const res = await fetch(`/api/platform/passes/${pass.id}/sheet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, tabGid: tab.gid }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Could not connect that tab.'); return; }
      setWarning(data.read?.headerWarning ?? null);
      setTabs(null);
      onConnected(data.pass);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/platform/passes/${pass.id}/sheet`, { method: 'DELETE' });
      if (res.ok) { setTabs(null); setWarning(null); onDisconnected(); }
    } finally { setBusy(false); }
  }

  const connected = !!pass.sheetId;

  return (
    <>
      <div onClick={onClose} style={scrimBg} />
      <div style={brandModal}>
        <div style={inspHead}>
          <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)' }}>Pass map</span>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>
        <div style={{ ...inspBody, gap: 16 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Connect the Google Sheet pass map, then pick the tab for this pass. Titles come from the sheet by J-Code; each tab is one Pass.
          </p>

          {connected && !tabs && (
            <div style={{ ...linkedRow, flexDirection: 'column', alignItems: 'stretch', gap: 8, padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-strong)' }}>{pass.sheetTabTitle}</span>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--muted-soft)' }}>
                {pass.sheetRowCount ?? 0} coded {pass.sheetRowCount === 1 ? 'video' : 'videos'} · {pass.sheetTabCount ?? 0} tabs in workbook
              </span>
              <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                <button onClick={loadTabs} disabled={busy} style={ghostBtn2}>{busy ? 'Working…' : 'Change tab'}</button>
                <button onClick={disconnect} disabled={busy} style={{ ...ghostBtn2, color: 'var(--warning)' }}>Disconnect</button>
              </div>
            </div>
          )}

          <Field label="Google Sheet link">
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadTabs(); }}
                placeholder="https://docs.google.com/spreadsheets/d/…" style={fieldInput} />
              <button onClick={loadTabs} disabled={busy || !url.trim()} style={{ ...generateImgBtn, whiteSpace: 'nowrap', opacity: busy || !url.trim() ? 0.6 : 1 }}>
                {busy ? '…' : 'Load tabs'}
              </button>
            </div>
          </Field>

          {error && (
            <div style={{ fontSize: 12.5, color: 'var(--warning)', background: 'var(--surface-inset)', border: '1px solid var(--warning)', borderRadius: 8, padding: 10, lineHeight: 1.45 }}>{error}</div>
          )}
          {warning && (
            <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--surface-inset)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, lineHeight: 1.45 }}>⚠ {warning}</div>
          )}

          {tabs && (
            <Field label={`Pick this pass's tab${workbookTitle ? ` — ${workbookTitle}` : ''}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tabs.map((t) => {
                  const isCurrent = pass.sheetTabGid === t.gid;
                  return (
                    <button key={t.gid} onClick={() => connectTab(t)} disabled={busy}
                      style={{ ...presetCard, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderColor: isCurrent ? 'var(--accent)' : 'var(--line)' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t.title}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--muted-soft)' }}>{isCurrent ? 'connected' : 'connect ▸'}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </div>
      </div>
    </>
  );
}

// ── Small helpers ──
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><label style={fieldLabel}>{label}</label>{children}</div>;
}
function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}><span style={fieldLabel}>{label}</span>{children}</div>;
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
const dropLineAbs: React.CSSProperties = { position: 'absolute', top: 4, width: 4, height: 203, borderRadius: 3, background: 'var(--accent)', boxShadow: '0 0 10px 2px var(--accent-soft)', animation: 'pfGlow 1s ease-in-out infinite', pointerEvents: 'none', zIndex: 5 };
const dropLineH: React.CSSProperties = { height: 4, borderRadius: 3, background: 'var(--accent)', boxShadow: '0 0 10px 2px var(--accent-soft)', margin: '2px 24px', animation: 'pfGlow 1s ease-in-out infinite' };
const catInput: React.CSSProperties = { background: 'transparent', border: '1px solid transparent', color: 'var(--text-strong)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.015em', padding: '3px 8px', borderRadius: 7, outline: 'none', minWidth: 40 };
const faintBtn: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--muted-soft)', fontSize: 12, padding: '5px 8px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' };
const tileCard: React.CSSProperties = { position: 'relative', width: 152, height: 203, borderRadius: 14, overflow: 'hidden', cursor: 'pointer', background: '#222', isolation: 'isolate' };
const tileTitle: React.CSSProperties = { position: 'absolute', top: 12, left: 13, right: 13, zIndex: 2, color: '#fff', fontWeight: 800, fontSize: 14.5, lineHeight: 1.14, letterSpacing: '-0.015em', textShadow: '0 1px 8px rgba(0,0,0,.5)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', cursor: 'text' };
const tileTitleEdit: React.CSSProperties = { position: 'absolute', top: 9, left: 10, right: 10, zIndex: 3, height: 88, background: 'rgba(0,0,0,0.42)', border: '1px solid var(--accent)', borderRadius: 6, color: '#fff', fontWeight: 800, fontSize: 14.5, lineHeight: 1.14, letterSpacing: '-0.015em', fontFamily: 'inherit', padding: '4px 6px', outline: 'none', resize: 'none' };
const tileBadge: React.CSSProperties = { position: 'absolute', bottom: 10, left: 12, zIndex: 2, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,.82)', background: 'rgba(0,0,0,.32)', padding: '3px 7px', borderRadius: 5 };
const addTileBtn: React.CSSProperties = { flex: '0 0 auto', width: 152, height: 203, border: '1.5px dashed var(--line-strong)', borderRadius: 14, background: 'transparent', color: 'var(--muted-soft)', fontSize: 13, fontWeight: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer' };
const addCatBtn: React.CSSProperties = { margin: '6px 24px 0', border: '1.5px dashed var(--line)', background: 'transparent', color: 'var(--muted)', fontSize: 13, fontWeight: 600, padding: 13, borderRadius: 10, width: 'calc(100% - 48px)', cursor: 'pointer' };
const scrimBg: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 30 };
const inspector: React.CSSProperties = { position: 'fixed', top: 0, right: 0, bottom: 0, width: 372, maxWidth: '92vw', background: 'var(--surface)', borderLeft: '1px solid var(--line)', zIndex: 40, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
const brandModal: React.CSSProperties = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 420, maxWidth: '94vw', maxHeight: '86vh', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, zIndex: 40, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };
const inspHead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid var(--line)' };
const inspBody: React.CSSProperties = { padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 };
const previewFrame: React.CSSProperties = { alignSelf: 'center', width: 208, height: 277, borderRadius: 16, overflow: 'hidden', position: 'relative', background: '#222', isolation: 'isolate', boxShadow: 'var(--shadow-md)' };
const pvTitle: React.CSSProperties = { position: 'absolute', top: 16, left: 17, right: 17, zIndex: 2, color: '#fff', fontWeight: 800, fontSize: 18, lineHeight: 1.13, letterSpacing: '-0.02em', textShadow: '0 1px 8px rgba(0,0,0,.5)' };
const fieldLabel: React.CSSProperties = { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted-soft)', fontWeight: 700 };
const fieldInput: React.CSSProperties = { background: 'var(--surface-inset)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 8, padding: '9px 11px', fontSize: 13.5, fontFamily: 'inherit', outline: 'none', width: '100%' };
const generateBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, background: 'var(--accent)', color: '#16130c', border: 0, borderRadius: 9, fontSize: 13.5, fontWeight: 700, padding: 11, cursor: 'pointer' };
const generateImgBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'var(--accent-soft)', color: 'var(--text-strong)', border: '1px solid var(--accent)', borderRadius: 8, fontSize: 13, fontWeight: 700, padding: 10, cursor: 'pointer' };
const miniBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--muted-soft)', fontSize: 11, fontWeight: 600, padding: '8px 4px', borderRadius: 7, cursor: 'pointer' };
const miniBtnOn: React.CSSProperties = { borderColor: 'var(--accent)', color: 'var(--text-strong)', background: 'var(--accent-soft)' };
const ghostBtn2: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, padding: '8px 12px', borderRadius: 8, cursor: 'pointer' };
const presetCard: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-inset)', cursor: 'pointer' };
const linkedRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-inset)', border: '1px solid var(--line)', borderRadius: 8, padding: 8 };
const versionPill: React.CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 700, fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--accent-strong)', background: 'var(--accent-soft)', border: '1px solid var(--accent-soft)', padding: '1px 6px', borderRadius: 5 };
const ctxMenu: React.CSSProperties = { position: 'fixed', zIndex: 61, minWidth: 176, background: 'var(--surface-2)', border: '1px solid var(--line-strong)', borderRadius: 10, padding: 5, display: 'flex', flexDirection: 'column', gap: 1, boxShadow: 'var(--shadow-lg)' };
const ctxItem: React.CSSProperties = { textAlign: 'left', background: 'transparent', border: 0, color: 'var(--text)', fontSize: 13, fontWeight: 500, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', width: '100%' };
