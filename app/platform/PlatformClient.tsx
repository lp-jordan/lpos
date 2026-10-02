'use client';

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import type { PlatformPass, PassStatus } from '@/lib/store/platform-pass-store';
import { resolveBrand } from '@/lib/platform/tile-background';
import { ContextMenu, type MenuEntry } from '@/components/shared/ContextMenu';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { useContextMenu } from '@/hooks/useContextMenu';
import {
  SortToggle, ViewToggle, ACTIVITY_BUCKETS, getActivityBucket,
  type SortMode, type ViewMode, type ActivityBucket,
} from '@/components/shared/ListControls';

const STATUS_LABEL: Record<PassStatus, string> = {
  draft: 'Draft', composed: 'Composed', linked: 'Linked',
  enriched: 'Enriched', exported: 'Exported', synced: 'Synced',
};
const STATUS_ORDER: PassStatus[] = ['draft', 'composed', 'linked', 'enriched', 'exported', 'synced'];

/** Sentinel filter value for passes not yet filed under a client. */
const NO_CLIENT = '__none__';

function statusColor(s: PassStatus): string {
  switch (s) {
    case 'synced': return 'var(--success)';
    case 'exported': return 'var(--accent)';
    case 'enriched': case 'linked': return '#6fa8d8';
    default: return 'var(--muted-soft)';
  }
}

const byTitle = (a: PlatformPass, b: PlatformPass) =>
  a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
const byRecent = (a: PlatformPass, b: PlatformPass) => b.updatedAt.localeCompare(a.updatedAt);

export function PlatformClient({ initialPasses, clientNames }: { initialPasses: PlatformPass[]; clientNames: string[] }) {
  const router = useRouter();
  const [passes, setPasses] = useState<PlatformPass[]>(initialPasses);
  const [creating, setCreating] = useState(false);
  const [clientTarget, setClientTarget] = useState<PlatformPass | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlatformPass | null>(null);
  const passMenu = useContextMenu<PlatformPass>();

  // ── Sort / filter / view state ───────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('activity');
  const [view, setView] = useState<ViewMode>('card');
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // URL + localStorage persistence — same contract as the Projects page: URL
  // wins on mount, localStorage keeps sort/view across clean /platform visits.
  const didRestoreRef = useRef(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    let lsSort: string | null = null;
    let lsView: string | null = null;
    try {
      lsSort = window.localStorage.getItem('lpos:platform:sort');
      lsView = window.localStorage.getItem('lpos:platform:view');
    } catch { /* localStorage may be blocked */ }
    const so = p.get('sort') ?? lsSort;
    const v  = p.get('view') ?? lsView;
    if (so === 'alpha' || so === 'activity') setSort(so);
    if (v === 'card' || v === 'list') setView(v);
    if (p.get('q')) setSearch(p.get('q')!);
    if (p.get('client')) setClientFilter(p.get('client')!);
    if (p.get('status')) setStatusFilter(p.get('status')!);
    didRestoreRef.current = true;
  }, []);
  useEffect(() => {
    if (!didRestoreRef.current) return;
    const p = new URLSearchParams();
    if (view !== 'card')     p.set('view', view);
    if (sort !== 'activity') p.set('sort', sort);
    if (search)              p.set('q', search);
    if (clientFilter)        p.set('client', clientFilter);
    if (statusFilter)        p.set('status', statusFilter);
    const qs = p.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
    try {
      window.localStorage.setItem('lpos:platform:sort', sort);
      window.localStorage.setItem('lpos:platform:view', view);
    } catch { /* ignore */ }
  }, [view, sort, search, clientFilter, statusFilter]);

  // ── Derived lists ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return passes.filter((p) => {
      if (clientFilter === NO_CLIENT ? p.clientName : clientFilter && p.clientName !== clientFilter) return false;
      if (statusFilter && p.status !== statusFilter) return false;
      if (!needle) return true;
      return p.title.toLowerCase().includes(needle)
        || (p.clientName ?? '').toLowerCase().includes(needle)
        || (p.sheetTabTitle ?? '').toLowerCase().includes(needle);
    });
  }, [passes, search, clientFilter, statusFilter]);

  const sorter = sort === 'alpha' ? byTitle : byRecent;
  const pinned = useMemo(() => filtered.filter((p) => p.pinnedAt).sort(sorter), [filtered, sorter]);
  const rest   = useMemo(() => filtered.filter((p) => !p.pinnedAt).sort(sorter), [filtered, sorter]);
  const restBuckets = useMemo(() => {
    if (sort !== 'activity') return null;
    const map: Record<ActivityBucket, PlatformPass[]> = { Today: [], Yesterday: [], 'This Week': [], 'This Month': [], Earlier: [] };
    for (const p of rest) map[getActivityBucket(p.updatedAt)].push(p);
    return ACTIVITY_BUCKETS.filter((b) => map[b].length > 0).map((b) => ({ bucket: b, passes: map[b] }));
  }, [rest, sort]);

  // Client filter options only list clients that actually have passes — a
  // filter that can return nothing is noise. (The create/assign pickers list
  // every client.)
  const clientOptions = useMemo(() => {
    const used = new Set(passes.map((p) => p.clientName).filter((c): c is string => !!c));
    const opts = [{ value: '', label: 'All clients' }, ...[...used].sort((a, b) => a.localeCompare(b)).map((c) => ({ value: c, label: c }))];
    if (passes.some((p) => !p.clientName)) opts.push({ value: NO_CLIENT, label: 'No client' });
    return opts;
  }, [passes]);
  const statusOptions = [{ value: '', label: 'Any status' }, ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))];

  const filtersActive = !!(search || clientFilter || statusFilter);

  // ── Mutations ────────────────────────────────────────────────────────────
  async function patchPass(id: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`/api/platform/passes/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as { pass?: PlatformPass; error?: string };
    if (!res.ok || !data.pass) throw new Error(data.error ?? 'Update failed');
    setPasses((ps) => ps.map((p) => (p.id === id ? data.pass! : p)));
  }

  async function deletePass(id: string) {
    await fetch(`/api/platform/passes/${id}`, { method: 'DELETE' });
    setPasses((ps) => ps.filter((p) => p.id !== id));
  }

  function buildMenu(p: PlatformPass): MenuEntry[] {
    return [
      { type: 'item', label: 'Open', icon: <IconOpen />, onClick: () => router.push(`/platform/${p.slug}`) },
      p.pinnedAt
        ? { type: 'item', label: 'Unpin', icon: <IconPin />, onClick: () => { void patchPass(p.id, { pinned: false }); } }
        : { type: 'item', label: 'Pin to top', icon: <IconPin />, onClick: () => { void patchPass(p.id, { pinned: true }); } },
      { type: 'item', label: p.clientName ? 'Change client…' : 'Set client…', icon: <IconClient />, onClick: () => setClientTarget(p) },
      { type: 'separator' },
      { type: 'item', label: 'Delete pass…', icon: <IconTrash />, danger: true, onClick: () => setDeleteTarget(p) },
    ];
  }

  // ── Render helpers ───────────────────────────────────────────────────────
  const open = (p: PlatformPass) => router.push(`/platform/${p.slug}`);
  const renderGroup = (list: PlatformPass[]) => view === 'card'
    ? (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
        {list.map((p) => <PassCard key={p.id} pass={p} onOpen={() => open(p)} onContextMenu={(e) => passMenu.open(e, p)} />)}
      </div>
    ) : (
      <div className="proj-list">
        {list.map((p) => <PassRow key={p.id} pass={p} onOpen={() => open(p)} onContextMenu={(e) => passMenu.open(e, p)} />)}
      </div>
    );

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '40px 24px 64px' }}>
      <style>{`@keyframes pfFadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, animation: 'pfFadeIn .6s ease both' }}>
        <h1 style={{ margin: 0, fontSize: 48, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-strong)', lineHeight: 1 }}>Platform</h1>
        <button onClick={() => setCreating(true)} style={primaryBtn}>+ Design New Pass</button>
      </div>

      {passes.length > 0 && (
        <div className="proj-controls" style={{ marginTop: 32, animation: 'pfFadeIn .6s ease both', animationDelay: '.04s' }}>
          <input className="proj-search" type="text" placeholder="Search passes…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Dropdown value={clientFilter} options={clientOptions} onChange={setClientFilter} searchable={clientOptions.length > 8} ariaLabel="Filter by client" />
          <Dropdown value={statusFilter} options={statusOptions} onChange={setStatusFilter} ariaLabel="Filter by status" />
          {filtersActive && (
            <button type="button" onClick={() => { setSearch(''); setClientFilter(''); setStatusFilter(''); }} style={clearBtn}>Clear</button>
          )}
          <div className="proj-controls-right">
            <span style={{ fontSize: 12, color: 'var(--muted-soft)', whiteSpace: 'nowrap' }}>
              {filtersActive ? `${filtered.length} of ${passes.length}` : passes.length} pass{(filtersActive ? filtered.length : passes.length) !== 1 ? 'es' : ''}
            </span>
            <SortToggle mode={sort} onChange={setSort} />
            <ViewToggle mode={view} onChange={setView} />
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, animation: 'pfFadeIn .6s ease both', animationDelay: '.08s' }}>
        {pinned.length > 0 && (
          <>
            <div className="proj-bucket-divider"><span>Pinned</span></div>
            {renderGroup(pinned)}
          </>
        )}
        {restBuckets
          ? restBuckets.map(({ bucket, passes: list }) => (
            <Fragment key={bucket}>
              <div className="proj-bucket-divider"><span>{bucket}</span></div>
              {renderGroup(list)}
            </Fragment>
          ))
          : rest.length > 0 && (
            <>
              {pinned.length > 0 && <div className="proj-bucket-divider"><span>All passes</span></div>}
              <div style={{ marginTop: pinned.length > 0 ? 0 : 20 }}>{renderGroup(rest)}</div>
            </>
          )}
      </div>

      {passes.length === 0 && (
        <div style={{ marginTop: 40, padding: '48px 24px', textAlign: 'center', color: 'var(--muted-soft)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          No passes yet. Click <b style={{ color: 'var(--muted)' }}>Design New Pass</b> to start composing one.
        </div>
      )}
      {passes.length > 0 && filtered.length === 0 && (
        <p className="m-empty" style={{ marginTop: 24 }}>No passes match these filters.</p>
      )}

      {passMenu.menu && (
        <ContextMenu x={passMenu.menu.x} y={passMenu.menu.y} items={buildMenu(passMenu.menu.data)} onClose={passMenu.close} />
      )}

      {creating && (
        <NewPassModal
          clientNames={clientNames}
          defaultClient={clientFilter && clientFilter !== NO_CLIENT ? clientFilter : ''}
          onClose={() => setCreating(false)}
          onCreated={(p) => router.push(`/platform/${p.slug}`)}
        />
      )}

      {clientTarget && (
        <ClientModal
          pass={clientTarget}
          clientNames={clientNames}
          onClose={() => setClientTarget(null)}
          onSave={async (name) => { await patchPass(clientTarget.id, { clientName: name }); }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete pass?"
          body={`"${deleteTarget.title}" and all of its categories and tiles will be permanently deleted.`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => { await deletePass(deleteTarget.id); setDeleteTarget(null); }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ── Card / row ──────────────────────────────────────────────────────────────

interface PassItemProps { pass: PlatformPass; onOpen: () => void; onContextMenu: (e: React.MouseEvent) => void }

function PassCard({ pass: p, onOpen, onContextMenu }: PassItemProps) {
  const brand = resolveBrand(p.brand, p.brandConfig);
  return (
    <button onClick={onOpen} onContextMenu={onContextMenu} style={passCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: brand.swatch, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: 'var(--muted-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.clientName ?? <i>No client</i>}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {p.pinnedAt && <span title="Pinned" style={{ color: 'var(--accent)', display: 'flex' }}><IconPin /></span>}
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: statusColor(p.status) }}>{STATUS_LABEL[p.status]}</span>
        </span>
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-strong)', letterSpacing: '-0.01em', lineHeight: 1.25 }}>{p.title}</div>
      <div style={{ fontSize: 11, color: 'var(--muted-soft)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
        updated {new Date(p.updatedAt).toLocaleDateString()}
      </div>
    </button>
  );
}

function PassRow({ pass: p, onOpen, onContextMenu }: PassItemProps) {
  const brand = resolveBrand(p.brand, p.brandConfig);
  return (
    <button type="button" className="proj-row" onClick={onOpen} onContextMenu={onContextMenu}
      style={{ gridTemplateColumns: '10px minmax(0, 1.6fr) minmax(0, 1fr) 90px 90px 16px', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: brand.swatch }} />
      <span className="proj-row-name" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {p.pinnedAt && <span title="Pinned" style={{ color: 'var(--accent)', display: 'flex', flexShrink: 0 }}><IconPin /></span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
      </span>
      <span className="proj-row-client">{p.clientName ?? <i>No client</i>}</span>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: statusColor(p.status) }}>{STATUS_LABEL[p.status]}</span>
      <span className="proj-row-date">{new Date(p.updatedAt).toLocaleDateString()}</span>
      <svg className="proj-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
    </button>
  );
}

// ── Dropdown (custom popover — native <select> menus render poorly in the dark theme) ──

interface Option { value: string; label: string }

function Dropdown({ value, options, onChange, searchable, placeholder, ariaLabel, block }: {
  value: string; options: Option[]; onChange: (v: string) => void;
  searchable?: boolean; placeholder?: string; ariaLabel?: string; block?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [openAt, setOpenAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const [q, setQ] = useState('');
  const current = options.find((o) => o.value === value);

  function toggle() {
    if (openAt) { setOpenAt(null); return; }
    const r = btnRef.current!.getBoundingClientRect();
    setQ('');
    setOpenAt({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 200) });
  }

  // Keep the popover on-screen.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el || !openAt) return;
    const { height, width } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.min(openAt.left, vw - width - 8);
    const top = openAt.top + height > vh ? Math.max(8, openAt.top - height - 40) : openAt.top;
    if (left !== openAt.left || top !== openAt.top) setOpenAt({ ...openAt, left, top });
  }, [openAt]);

  useEffect(() => {
    if (!openAt) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpenAt(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); setOpenAt(null); } }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [openAt]);

  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  const pick = (v: string) => { onChange(v); setOpenAt(null); };

  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle} aria-label={ariaLabel} aria-haspopup="listbox"
        style={{ ...dropdownBtn, ...(block ? { width: '100%' } : null), color: current ? 'var(--text)' : 'var(--muted-soft)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.label ?? placeholder ?? 'Select…'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--muted-soft)' }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {openAt && createPortal(
        <div ref={popRef} className="ctx-menu" role="listbox"
          style={{ position: 'fixed', left: openAt.left, top: openAt.top, minWidth: openAt.width, zIndex: 1000, maxHeight: 320, display: 'flex', flexDirection: 'column' }}>
          {searchable && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
              onKeyDown={(e) => { if (e.key === 'Enter' && shown.length > 0) pick(shown[0].value); }}
              style={{ ...popSearch }} />
          )}
          <div style={{ overflowY: 'auto' }}>
            {shown.map((o) => (
              <button key={o.value} type="button" role="option" aria-selected={o.value === value}
                className="ctx-item" onClick={() => pick(o.value)}
                style={{ width: '100%', fontWeight: o.value === value ? 700 : undefined, color: o.value === value ? 'var(--accent-strong)' : undefined }}>
                <span>{o.label}</span>
              </button>
            ))}
            {shown.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--muted-soft)' }}>No matches</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Modals ──────────────────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NewPassModal({ clientNames, defaultClient, onClose, onCreated }: {
  clientNames: string[]; defaultClient: string; onClose: () => void; onCreated: (p: PlatformPass) => void;
}) {
  const [title, setTitle] = useState('');
  const [client, setClient] = useState(defaultClient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = clientNames.map((c) => ({ value: c, label: c }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Give the pass a title.'); return; }
    if (!client) { setError('Choose the client this pass belongs to.'); return; }
    setBusy(true); setError('');
    const res = await fetch('/api/platform/passes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, clientName: client }),
    });
    const data = await res.json().catch(() => ({})) as { pass?: PlatformPass; error?: string };
    if (!res.ok || !data.pass) { setError(data.error ?? 'Could not create pass.'); setBusy(false); return; }
    onCreated(data.pass);
  }

  return (
    <ModalShell title="Design new pass" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <div className="modal-field">
          <label className="modal-label">Title</label>
          <input className="modal-input" type="text" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New pass title…" />
        </div>
        <div className="modal-field">
          <label className="modal-label">Client</label>
          <Dropdown value={client} options={options} onChange={setClient} searchable placeholder="Choose a client…" ariaLabel="Client" block />
        </div>
        {error && <p className="modal-body-text" style={{ color: '#e07070', margin: 0 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="modal-btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

function ClientModal({ pass, clientNames, onClose, onSave }: {
  pass: PlatformPass; clientNames: string[]; onClose: () => void; onSave: (name: string) => Promise<void>;
}) {
  const [client, setClient] = useState(pass.clientName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = clientNames.map((c) => ({ value: c, label: c }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!client) { setError('Choose a client.'); return; }
    if (client === pass.clientName) { onClose(); return; }
    setBusy(true); setError('');
    try { await onSave(client); onClose(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <ModalShell title={pass.clientName ? 'Change client' : 'Set client'} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p className="modal-body-text" style={{ margin: 0 }}>Which client does <b>{pass.title}</b> belong to?</p>
        <div className="modal-field">
          <label className="modal-label">Client</label>
          <Dropdown value={client} options={options} onChange={setClient} searchable placeholder="Choose a client…" ariaLabel="Client" block />
        </div>
        {error && <p className="modal-body-text" style={{ color: '#e07070', margin: 0 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="modal-btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function IconOpen()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>; }
function IconPin()    { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z"/></svg>; }
function IconClient() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></svg>; }
function IconTrash()  { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>; }

// ── Styles ──────────────────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  background: 'var(--accent)', color: '#1a1206', border: 'none', borderRadius: 9,
  padding: '9px 16px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
};
const clearBtn: React.CSSProperties = {
  background: 'transparent', border: 0, color: 'var(--muted)', fontSize: 12.5, fontWeight: 600,
  cursor: 'pointer', padding: '4px 6px', font: 'inherit',
};
const dropdownBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  minWidth: 140, maxWidth: 260, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8,
  background: 'var(--surface-inset)', font: 'inherit', fontSize: '0.88rem', cursor: 'pointer', textAlign: 'left',
};
const popSearch: React.CSSProperties = {
  margin: '2px 2px 6px', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6,
  background: 'var(--surface-inset)', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none',
};
const passCard: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left',
  background: 'var(--surface-raised)', border: '1px solid var(--line)', borderRadius: 14,
  padding: 16, cursor: 'pointer', color: 'var(--text)', minHeight: 104,
};
