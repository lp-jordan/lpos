'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Prospect, ProspectStatus } from '@/lib/models/prospect';
import type { UserSummary } from '@/lib/models/user';
import { NewPersonModal } from '@/components/prospects/NewPersonModal';
import { OwnerAvatar } from '@/components/projects/OwnerAvatar';
import { RenameModal } from '@/components/shared/RenameModal';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { ContextMenu } from '@/components/shared/ContextMenu';
import type { MenuEntry } from '@/components/shared/ContextMenu';
import { useContextMenu } from '@/hooks/useContextMenu';
type ViewMode      = 'card' | 'list';
type ScopeFilter   = 'all' | 'mine' | 'others';
type TabFilter     = 'prospects' | 'active' | 'all';
type EntityFilter  = 'all' | 'individual' | 'organization';
type SortMode      = 'updated' | 'name' | 'value' | 'newest' | 'billing';

function compactCurrency(v: number): string {
  if (v === 0) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000)      return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`;
  return `$${v.toLocaleString()}`;
}

// ── Badges ────────────────────────────────────────────────────────────────────

// Subtle status chip — used for prospect/active labels, de-emphasised
const STATUS_STYLE: Record<ProspectStatus, { color: string }> = {
  prospect: { color: 'rgba(91,141,217,0.55)'  },
  active:   { color: 'rgba(90,185,90,0.55)'   },
  inactive: { color: 'rgba(150,150,150,0.55)' },
};
const STATUS_LABELS: Record<ProspectStatus, string> = {
  prospect: 'Prospect',
  active:   'Client',
  inactive: 'Inactive',
};
function StatusBadge({ status }: { status: ProspectStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{
      fontSize: '0.68rem', fontWeight: 500, color: s.color,
      letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// Prominent billing status badge — used only on active clients
const BILLING_BADGE_STYLE: Record<string, { bg: string; border: string; color: string; label: string }> = {
  not_started: { bg: 'rgba(180,140,80,0.15)',  border: '#b48c50', color: '#b48c50', label: 'Not Started' },
  active:      { bg: 'rgba(90,185,90,0.15)',   border: '#5ab95a', color: '#5ab95a', label: 'Active'      },
  declined:    { bg: 'rgba(224,82,82,0.15)',   border: '#e05252', color: '#e05252', label: 'Declined'    },
  cancelled:   { bg: 'rgba(130,130,130,0.12)', border: '#888',    color: '#888',    label: 'Cancelled'   },
};
function BillingBadge({ status }: { status: string | null }) {
  const cfg = BILLING_BADGE_STYLE[status ?? 'not_started'] ?? BILLING_BADGE_STYLE['not_started'];
  return (
    <span style={{
      display: 'inline-block', padding: '0.2rem 0.55rem', borderRadius: '999px',
      border: `1px solid ${cfg.border}`, backgroundColor: cfg.bg, color: cfg.color,
      fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em', whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeDate(iso: string): string {
  try {
    const diff  = Date.now() - new Date(iso).getTime();
    const days  = Math.floor(diff / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30)  return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 8)  return `${weeks}w ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  } catch { return ''; }
}

function stripMentions(text: string): string {
  return text.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1');
}

function AvatarStrip({ userIds, allUsers }: { userIds: string[]; allUsers: UserSummary[] }) {
  const users = userIds.map((id) => allUsers.find((u) => u.id === id)).filter(Boolean) as UserSummary[];
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {users.slice(0, 4).map((u) => <OwnerAvatar key={u.id} user={u} size={22} />)}
      {users.length > 4 && (
        <span style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: '22px' }}>+{users.length - 4}</span>
      )}
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span className={`proj-check${checked ? ' proj-check--checked' : ''}`} aria-hidden="true">
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="2 6 5 9 10 3" />
      </svg>
    </span>
  );
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="m-view-toggle">
      <button className={`m-view-btn${mode === 'card' ? ' active' : ''}`} type="button" onClick={() => onChange('card')} aria-label="Card view">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
      </button>
      <button className={`m-view-btn${mode === 'list' ? ' active' : ''}`} type="button" onClick={() => onChange('list')} aria-label="List view">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </button>
    </div>
  );
}

// ── Person card ───────────────────────────────────────────────────────────────

interface CardProps {
  person:     Prospect;
  allUsers:   UserSummary[];
  lastUpdate?: string;
  selected:   boolean;
  onNavigate: () => void;
  onSelect:   (e: React.MouseEvent) => void;
  onContext:  (e: React.MouseEvent) => void;
}

function PersonCard({ person, allUsers, lastUpdate, selected, onNavigate, onSelect, onContext }: CardProps) {
  const dateLabel = relativeDate(person.updatedAt);
  return (
    <div
      className={`proj-client-card${selected ? ' proj-client-card--selected' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', cursor: 'pointer', userSelect: 'none' }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) { onSelect(e); return; }
        onNavigate();
      }}
      onContextMenu={onContext}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ marginTop: 2, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); onSelect(e); }}>
            <Checkbox checked={selected} />
          </span>
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)', lineHeight: 1.3, wordBreak: 'break-word' }}>
            {person.company}
          </span>
        </div>
        {person.status === 'active'
          ? <BillingBadge status={person.recurringBillingStatus} />
          : <StatusBadge status={person.status} />
        }
      </div>

      {lastUpdate ? (
        <p style={{
          margin: 0, fontSize: '0.78rem', color: 'var(--muted)',
          lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }}>
          <span style={{ color: 'var(--muted-soft)', fontWeight: 500, marginRight: 4 }}>{dateLabel} ·</span>
          {stripMentions(lastUpdate)}
        </p>
      ) : null}

      {person.archived && (
        <span style={{
          fontSize: '0.7rem', color: 'var(--muted)',
          background: 'rgba(255,255,255,0.05)', border: '1px solid var(--color-border,#333)',
          borderRadius: 4, padding: '1px 6px', alignSelf: 'flex-start',
        }}>
          Archived
        </span>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginTop: 'auto' }}>
        <AvatarStrip userIds={person.assignedTo} allUsers={allUsers} />
        {!lastUpdate && (
          <span style={{ fontSize: '0.75rem', color: 'var(--muted-soft)' }}>{dateLabel}</span>
        )}
      </div>
    </div>
  );
}

// ── Person row ────────────────────────────────────────────────────────────────

function PersonRow({ person, allUsers, selected, onNavigate, onSelect, onContext }: Omit<CardProps, 'lastUpdate'>) {
  return (
    <div
      className={`proj-client-row${selected ? ' proj-client-row--selected' : ''}`}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) { onSelect(e); return; }
        onNavigate();
      }}
      onContextMenu={onContext}
    >
      <span onClick={(e) => { e.stopPropagation(); onSelect(e); }}>
        <Checkbox checked={selected} />
      </span>
      <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--text-strong)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {person.company}
      </span>
      {person.status === 'active'
        ? <BillingBadge status={person.recurringBillingStatus} />
        : <StatusBadge status={person.status} />
      }
      <AvatarStrip userIds={person.assignedTo} allUsers={allUsers} />
      <span style={{ fontSize: '0.78rem', color: 'var(--muted-soft)', whiteSpace: 'nowrap' }}>
        {relativeDate(person.updatedAt)}
      </span>
      {person.archived && (
        <span className="proj-archived-badge proj-archived-badge--inline">Archived</span>
      )}
      <svg className="proj-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  );
}

// ── Bulk bar ──────────────────────────────────────────────────────────────────

function BulkBar({ count, onArchive, onDelete, onDeselect }: {
  count: number; onArchive: () => void; onDelete: () => void; onDeselect: () => void;
}) {
  return (
    <div className="proj-bulk-bar">
      <span className="proj-bulk-count">{count} selected</span>
      <button type="button" className="proj-bulk-btn" onClick={onArchive}>Archive</button>
      <button type="button" className="proj-bulk-btn proj-bulk-btn--danger" onClick={onDelete}>Delete</button>
      <button type="button" className="proj-bulk-btn" onClick={onDeselect} style={{ marginLeft: 'auto' }}>Deselect all</button>
    </div>
  );
}

// ── Parent row ────────────────────────────────────────────────────────────────

interface ParentRowProps {
  clientId:   string;
  clientName: string;
  children:   Prospect[];
  onNavigate: () => void;
}

function ParentRow({ clientName, children, onNavigate }: ParentRowProps) {
  const totalMRR = children.reduce(
    (s, p) => s + (p.monthlyLpRevenue ?? 0) + (p.monthlyLpTechRevenue ?? 0),
    0,
  );
  return (
    <div
      className="proj-client-row"
      style={{ cursor: 'pointer', userSelect: 'none', background: 'rgba(255,255,255,0.02)' }}
      onClick={onNavigate}
    >
      <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--text-strong)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {clientName}
      </span>
      <span style={{ fontSize: '0.72rem', color: 'var(--muted)', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
        {children.length} engagement{children.length !== 1 ? 's' : ''}
      </span>
      {totalMRR > 0 && (
        <span style={{ fontSize: '0.78rem', color: 'var(--muted-soft)', whiteSpace: 'nowrap' }}>
          {compactCurrency(totalMRR)}/mo
        </span>
      )}
      <svg className="proj-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface Props {
  initialPeople:     Prospect[];
  currentUserId:     string;
  accessUsers:       UserSummary[];
  lastUpdateBodies?: Record<string, string>;
  parentClients:     { clientId: string; name: string }[];
}

export function PeoplePageClient({ initialPeople, currentUserId, accessUsers, lastUpdateBodies, parentClients }: Props) {
  const router = useRouter();

  // name → clientId map for O(1) parent lookup + navigation URL building
  const parentMap = new Map(parentClients.map((c) => [c.name, c.clientId]));

  const [people,       setPeople]       = useState<Prospect[]>(initialPeople);
  const [search,       setSearch]       = useState('');
  const [viewMode,     setViewMode]     = useState<ViewMode>('card');
  const [scope,        setScope]        = useState<ScopeFilter>('all');
  const [tab,          setTab]          = useState<TabFilter>('prospects');
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('all');
  const [sort,         setSort]         = useState<SortMode>('updated');
  const [showArchived, setShowArchived] = useState(false);
  const [showNew,      setShowNew]      = useState(false);
  const [showFilter,   setShowFilter]   = useState(false);
  const filterRef   = useRef<HTMLDivElement>(null);
  const didRestoreRef = useRef(false);

  const [selected,       setSelected]       = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  const [renaming,       setRenaming]       = useState<{ personId: string; company: string } | null>(null);
  const [confirmDelete,  setConfirmDelete]  = useState<{ ids: string[]; label: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<{ ids: string[]; label: string; unarchive?: boolean } | null>(null);

  const personMenu = useContextMenu<Prospect>();

  // ── Persist filters in URL + localStorage ──────────────────────────────────
  //
  // URL persistence makes a filter combo shareable / reloadable. localStorage
  // makes it survive a nav-link round-trip back to a clean /people URL (the
  // top-bar "People" link, the home tile, the Back button on a person detail
  // page — none of those carry query params). Precedence on mount:
  // URL param > localStorage > default. Both are kept in sync on every change.
  // `search` and `showArchived` stay URL-only on purpose — they're transient.

  // On mount: restore filter state from URL, falling back to localStorage.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get('tab')    as TabFilter   | null;
    const so = p.get('sort')  as SortMode    | null;
    const v = p.get('view')   as ViewMode    | null;
    const sc = p.get('scope') as ScopeFilter | null;
    const en = p.get('entity') as EntityFilter | null;
    const q = p.get('q');
    const ar = p.get('archived');
    let lsTab:    TabFilter    | null = null;
    let lsSort:   SortMode     | null = null;
    let lsView:   ViewMode     | null = null;
    let lsScope:  ScopeFilter  | null = null;
    let lsEntity: EntityFilter | null = null;
    try {
      const x = window.localStorage.getItem('lpos:people:tab');
      if (x && ['prospects','active','all'].includes(x))                     lsTab    = x as TabFilter;
      const y = window.localStorage.getItem('lpos:people:sort');
      if (y && ['updated','name','value','newest','billing'].includes(y))    lsSort   = y as SortMode;
      const z = window.localStorage.getItem('lpos:people:view');
      if (z === 'card' || z === 'list')                                       lsView   = z;
      const w = window.localStorage.getItem('lpos:people:scope');
      if (w && ['all','mine','others'].includes(w))                          lsScope  = w as ScopeFilter;
      const u = window.localStorage.getItem('lpos:people:entity');
      if (u && ['all','individual','organization'].includes(u))              lsEntity = u as EntityFilter;
    } catch { /* localStorage may be blocked */ }
    if      (t  && ['prospects','active','all'].includes(t))                   setTab(t);
    else if (lsTab)                                                            setTab(lsTab);
    if      (so && ['updated','name','value','newest','billing'].includes(so)) setSort(so);
    else if (lsSort)                                                           setSort(lsSort);
    if      (v  && ['card','list'].includes(v))                                setViewMode(v);
    else if (lsView)                                                           setViewMode(lsView);
    if      (sc && ['all','mine','others'].includes(sc))                       setScope(sc);
    else if (lsScope)                                                          setScope(lsScope);
    if      (en && ['all','individual','organization'].includes(en))           setEntityFilter(en);
    else if (lsEntity)                                                         setEntityFilter(lsEntity);
    if (q  != null)                                                            setSearch(q);
    if (ar === '1')                                                            setShowArchived(true);
    didRestoreRef.current = true;
  }, []);

  // After restore: keep URL + localStorage in sync whenever filters change.
  useEffect(() => {
    if (!didRestoreRef.current) return;
    const p = new URLSearchParams();
    if (tab          !== 'prospects') p.set('tab',     tab);
    if (sort         !== 'updated')   p.set('sort',    sort);
    if (viewMode     !== 'card')      p.set('view',    viewMode);
    if (scope        !== 'all')       p.set('scope',   scope);
    if (entityFilter !== 'all')       p.set('entity',  entityFilter);
    if (search)                       p.set('q',       search);
    if (showArchived)                 p.set('archived','1');
    const qs = p.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
    try {
      window.localStorage.setItem('lpos:people:tab',    tab);
      window.localStorage.setItem('lpos:people:sort',   sort);
      window.localStorage.setItem('lpos:people:view',   viewMode);
      window.localStorage.setItem('lpos:people:scope',  scope);
      window.localStorage.setItem('lpos:people:entity', entityFilter);
    } catch { /* ignore */ }
  }, [tab, sort, viewMode, scope, entityFilter, search, showArchived]);

  // Close filter popover on outside click
  useEffect(() => {
    if (!showFilter) return;
    function handle(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilter(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showFilter]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const tabFiltered = people.filter((p) => {
    if (tab === 'prospects') return p.status === 'prospect';
    if (tab === 'active')    return p.status === 'active' || p.status === 'inactive';
    return true;
  });

  const filtered = tabFiltered.filter((p) => {
    if (!showArchived && p.archived)                                        return false;
    if (showArchived  && !p.archived)                                       return false;
    if (scope === 'mine'   && !p.assignedTo.includes(currentUserId))       return false;
    if (scope === 'others' &&  p.assignedTo.includes(currentUserId))       return false;
    if (entityFilter !== 'all' && p.entityType !== entityFilter)            return false;
    if (search && !p.company.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sort) {
      case 'name':    return a.company.localeCompare(b.company, undefined, { sensitivity: 'base' });
      case 'newest':  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'value': {
        const va = a.status === 'active'
          ? ((a.monthlyLpRevenue ?? 0) + (a.monthlyLpTechRevenue ?? 0)) * 12
          : (a.estimatedFirstYearValue ?? 0);
        const vb = b.status === 'active'
          ? ((b.monthlyLpRevenue ?? 0) + (b.monthlyLpTechRevenue ?? 0)) * 12
          : (b.estimatedFirstYearValue ?? 0);
        return vb - va;
      }
      case 'billing': {
        const priority: Record<string, number> = { declined: 0, not_started: 1, cancelled: 2, active: 3 };
        const pa = priority[a.recurringBillingStatus ?? 'not_started'] ?? 1;
        const pb = priority[b.recurringBillingStatus ?? 'not_started'] ?? 1;
        return pa !== pb ? pa - pb : a.company.localeCompare(b.company, undefined, { sensitivity: 'base' });
      }
      default: return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }
  });

  const sortedIds     = sorted.map((p) => p.prospectId);
  const filteredIds   = sortedIds; // used for range-select
  const archivedCount = tabFiltered.filter((p) => p.archived).length;

  const prospectCount = people.filter((p) => p.status === 'prospect' && !p.archived).length;
  const activeCount   = people.filter((p) => (p.status === 'active' || p.status === 'inactive') && !p.archived).length;

  // Pipeline summary (always computed from all non-archived records, tab-independent)
  const allProspects     = people.filter((p) => p.status === 'prospect' && !p.archived);
  const allActiveClients = people.filter((p) => p.status === 'active'   && !p.archived);
  const pipelineEst = allProspects.reduce((s, p) => s + (p.estimatedFirstYearValue ?? 0), 0);
  const activeMRR   = allActiveClients.reduce((s, p) => s + (p.monthlyLpRevenue ?? 0) + (p.monthlyLpTechRevenue ?? 0), 0);

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleSelect(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setLastSelectedId(id);
  }

  function rangeSelect(id: string) {
    if (!lastSelectedId) { toggleSelect(id); return; }
    const a = filteredIds.indexOf(lastSelectedId);
    const b = filteredIds.indexOf(id);
    if (a === -1 || b === -1) { toggleSelect(id); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected((prev) => {
      const next = new Set(prev);
      filteredIds.slice(lo, hi + 1).forEach((pid) => next.add(pid));
      return next;
    });
    setLastSelectedId(id);
  }

  function handleSelectClick(id: string, e: React.MouseEvent) {
    if (e.shiftKey) { rangeSelect(id); return; }
    toggleSelect(id, e);
  }

  // ── API actions ────────────────────────────────────────────────────────────

  async function apiRename(personId: string, company: string) {
    const res = await fetch(`/api/prospects/${personId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ company }),
    });
    if (!res.ok) { const d = await res.json() as { error?: string }; throw new Error(d.error ?? 'Rename failed.'); }
    setPeople((prev) => prev.map((p) => p.prospectId === personId ? { ...p, company } : p));
  }

  async function apiArchive(ids: string[], unarchive = false) {
    await Promise.allSettled(
      ids.map((id) => fetch(`/api/prospects/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ archived: !unarchive }),
      })),
    );
    setPeople((prev) => prev.map((p) => ids.includes(p.prospectId) ? { ...p, archived: !unarchive } : p));
    setSelected(new Set());
  }

  async function apiDelete(ids: string[]) {
    await Promise.allSettled(ids.map((id) => fetch(`/api/prospects/${id}`, { method: 'DELETE' })));
    setPeople((prev) => prev.filter((p) => !ids.includes(p.prospectId)));
    setSelected(new Set());
  }

  // ── Context menu ───────────────────────────────────────────────────────────

  function buildMenu(p: Prospect): MenuEntry[] {
    return [
      {
        type: 'item', label: 'Open',
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
        onClick: () => router.push(`/people/${p.prospectId}`),
      },
      {
        type: 'item', label: 'Rename',
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
        onClick: () => setRenaming({ personId: p.prospectId, company: p.company }),
      },
      { type: 'separator' },
      {
        type: 'item', label: p.archived ? 'Unarchive' : 'Archive',
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
        onClick: () => setConfirmArchive({ ids: [p.prospectId], label: p.company, unarchive: p.archived }),
      },
      { type: 'separator' },
      {
        type: 'item', label: 'Delete', danger: true,
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
        onClick: () => setConfirmDelete({ ids: [p.prospectId], label: p.company }),
      },
    ];
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page-stack">
      <div className="proj-controls">
          {/* Inline type tabs */}
          <div className="proj-filter-pills" style={{ flexShrink: 0 }}>
            <button type="button" className={`proj-filter-pill${tab === 'prospects' ? ' active' : ''}`} onClick={() => { setTab('prospects'); setShowArchived(false); setSelected(new Set()); }}>
              Prospects{prospectCount > 0 ? ` (${prospectCount})` : ''}
            </button>
            <button type="button" className={`proj-filter-pill${tab === 'active' ? ' active' : ''}`} onClick={() => { setTab('active'); setShowArchived(false); setSelected(new Set()); }}>
              Clients{activeCount > 0 ? ` (${activeCount})` : ''}
            </button>
            <button type="button" className={`proj-filter-pill${tab === 'all' ? ' active' : ''}`} onClick={() => { setTab('all'); setShowArchived(false); setSelected(new Set()); }}>
              All
            </button>
          </div>
          <input
            className="proj-search"
            type="text"
            placeholder="Search people…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="proj-controls-right">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              style={{
                padding: '0.3rem 0.6rem', borderRadius: 6, fontSize: '0.8rem', fontWeight: 500,
                border: '1px solid var(--color-border,#444)', background: 'var(--color-input-bg,#1a1a1a)',
                color: 'var(--muted)', cursor: 'pointer',
              }}
            >
              <option value="updated">Last updated</option>
              <option value="name">Name A–Z</option>
              <option value="value">Value ↓</option>
              <option value="newest">Newest</option>
              <option value="billing">Sub. status</option>
            </select>
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            <button type="button" className="proj-new-btn" onClick={() => setShowNew(true)}>
              + New
            </button>
          </div>
        </div>

      {/* Pipeline summary strip */}

      {(allProspects.length > 0 || allActiveClients.length > 0) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '1.5rem',
          padding: '0.55rem 0.9rem', borderRadius: 8,
          background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)',
          fontSize: '0.8rem', flexWrap: 'wrap',
        }}>
          {allProspects.length > 0 && (
            <span style={{ color: 'var(--muted-soft)' }}>
              <span style={{ color: '#5b8dd9', fontWeight: 600 }}>{allProspects.length}</span>
              {' '}Prospect{allProspects.length !== 1 ? 's' : ''}
              {pipelineEst > 0 && (
                <span style={{ color: 'var(--muted)', marginLeft: 6 }}>· ~{compactCurrency(pipelineEst)} est.</span>
              )}
            </span>
          )}
          {allProspects.length > 0 && allActiveClients.length > 0 && (
            <span style={{ color: 'var(--line-strong)' }}>|</span>
          )}
          {allActiveClients.length > 0 && (
            <span style={{ color: 'var(--muted-soft)' }}>
              <span style={{ color: '#5ab95a', fontWeight: 600 }}>{allActiveClients.length}</span>
              {' '}Active
              {activeMRR > 0 && (
                <span style={{ color: 'var(--muted)', marginLeft: 6 }}>· {compactCurrency(activeMRR)}/mo</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Filter row */}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Filter popover */}
        <div ref={filterRef} style={{ position: 'relative' }}>
          {(() => {
            const activeCount2 = (scope !== 'all' ? 1 : 0) + (entityFilter !== 'all' ? 1 : 0);
            return (
              <button
                type="button"
                onClick={() => setShowFilter((v) => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '0.3rem 0.75rem', borderRadius: 6, fontSize: '0.8rem', fontWeight: 500,
                  border: `1px solid ${showFilter || activeCount2 > 0 ? 'var(--accent)' : 'var(--color-border,#444)'}`,
                  background: showFilter || activeCount2 > 0 ? 'var(--accent-soft)' : 'var(--color-input-bg,#1a1a1a)',
                  color: showFilter || activeCount2 > 0 ? 'var(--accent-strong)' : 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                Filter
                {activeCount2 > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 16, height: 16, borderRadius: '50%', fontSize: '0.68rem', fontWeight: 700,
                    background: 'var(--accent)', color: '#fff',
                  }}>
                    {activeCount2}
                  </span>
                )}
              </button>
            );
          })()}

          {showFilter && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60,
              background: 'var(--surface-1)', border: '1px solid var(--line)',
              borderRadius: 10, padding: '14px 16px', minWidth: 220,
              boxShadow: 'var(--shadow-md)', display: 'flex', flexDirection: 'column', gap: 16,
            }}>
              {/* Assigned */}
              <div>
                <p style={{ margin: '0 0 8px', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted-soft)', textTransform: 'uppercase' }}>Assigned</p>
                <div className="proj-filter-pills">
                  {([['all', 'All'], ['mine', 'Mine'], ['others', 'Others']] as const).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`proj-filter-pill${scope === val ? ' active' : ''}`}
                      onClick={() => setScope(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Entity */}
              <div>
                <p style={{ margin: '0 0 8px', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted-soft)', textTransform: 'uppercase' }}>Entity</p>
                <div className="proj-filter-pills">
                  {([['all', 'All'], ['individual', 'Individual'], ['organization', 'Organization']] as const).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`proj-filter-pill${entityFilter === val ? ' active' : ''}`}
                      onClick={() => setEntityFilter(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Reset */}
              {(scope !== 'all' || entityFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => { setScope('all'); setEntityFilter('all'); setShowArchived(false); setSelected(new Set()); }}
                  style={{ alignSelf: 'flex-start', background: 'none', border: 'none', fontSize: '0.78rem', color: 'var(--muted)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                >
                  Reset filters
                </button>
              )}
            </div>
          )}
        </div>

        {archivedCount > 0 && (
          <button
            type="button"
            className="proj-archived-toggle"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
          </button>
        )}
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          onArchive={() => {
            const ids = Array.from(selected);
            if (ids.length > 0) void apiArchive(ids);
          }}
          onDelete={() => {
            const ids = Array.from(selected);
            if (ids.length > 0) setConfirmDelete({ ids, label: `${ids.length} people` });
          }}
          onDeselect={() => setSelected(new Set())}
        />
      )}

      {/* Empty states */}
      {people.length === 0 && (
        <div className="proj-empty-state">
          <p>No people yet.</p>
          <button type="button" className="proj-new-btn" onClick={() => setShowNew(true)}>
            Add your first person
          </button>
        </div>
      )}

      {people.length > 0 && sorted.length === 0 && (
        <p className="m-empty">No results match your filters.</p>
      )}

      {/* Card view */}
      {viewMode === 'card' && sorted.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {(() => {
            const showingClients = tab === 'active' || tab === 'all';
            const useGrouped     = showingClients && !search;
            const seen           = new Set<string>();
            const rendered: React.ReactNode[] = [];
            for (const p of sorted) {
              if (!useGrouped) {
                const isChild     = p.status !== 'prospect' && p.clientName && parentMap.has(p.clientName);
                const displayName = isChild ? `${p.clientName} › ${p.company}` : undefined;
                rendered.push(
                  <PersonCard key={p.prospectId} person={displayName ? { ...p, company: displayName } : p}
                    allUsers={accessUsers} lastUpdate={lastUpdateBodies?.[p.prospectId]}
                    selected={selected.has(p.prospectId)} onNavigate={() => router.push(`/people/${p.prospectId}`)}
                    onSelect={(e) => handleSelectClick(p.prospectId, e)} onContext={(e) => personMenu.open(e, p)} />,
                );
                continue;
              }
              if (p.status === 'prospect') {
                rendered.push(
                  <PersonCard key={p.prospectId} person={p} allUsers={accessUsers}
                    lastUpdate={lastUpdateBodies?.[p.prospectId]} selected={selected.has(p.prospectId)}
                    onNavigate={() => router.push(`/people/${p.prospectId}`)}
                    onSelect={(e) => handleSelectClick(p.prospectId, e)} onContext={(e) => personMenu.open(e, p)} />,
                );
                continue;
              }
              const parentName     = p.clientName && parentMap.has(p.clientName) ? p.clientName : null;
              const parentClientId = parentName ? parentMap.get(parentName) : null;
              if (parentName && parentClientId) {
                if (seen.has(parentName)) continue;
                seen.add(parentName);
                const children = sorted.filter((c) => c.clientName === parentName);
                const totalMRR = children.reduce((s, c) => s + (c.monthlyLpRevenue ?? 0) + (c.monthlyLpTechRevenue ?? 0), 0);
                rendered.push(
                  <div key={`parent-card-${parentName}`} className="proj-client-card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', cursor: 'pointer', userSelect: 'none', background: 'rgba(255,255,255,0.02)' }}
                    onClick={() => router.push(`/people/org/${parentClientId}`)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)', lineHeight: 1.3 }}>{parentName}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--muted)', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                        {children.length} engagement{children.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {totalMRR > 0 && <span style={{ fontSize: '0.8rem', color: 'var(--muted-soft)' }}>{compactCurrency(totalMRR)}/mo</span>}
                    <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted)' }}>{children.map((c) => c.company).join(' · ')}</p>
                  </div>,
                );
              } else {
                rendered.push(
                  <PersonCard key={p.prospectId} person={p} allUsers={accessUsers}
                    lastUpdate={lastUpdateBodies?.[p.prospectId]} selected={selected.has(p.prospectId)}
                    onNavigate={() => router.push(`/people/${p.prospectId}`)}
                    onSelect={(e) => handleSelectClick(p.prospectId, e)} onContext={(e) => personMenu.open(e, p)} />,
                );
              }
            }
            return rendered;
          })()}
        </div>
      )}

      {/* List view */}
      {viewMode === 'list' && sorted.length > 0 && (
        <div className="proj-list">
          {(() => {
            const showingClients = tab === 'active' || tab === 'all';
            const useGrouped     = showingClients && !search;
            const seen           = new Set<string>();
            const rendered: React.ReactNode[] = [];
            for (const p of sorted) {
              if (!useGrouped) {
                const isChild     = p.status !== 'prospect' && p.clientName && parentMap.has(p.clientName);
                const displayName = isChild ? `${p.clientName} › ${p.company}` : undefined;
                rendered.push(
                  <PersonRow key={p.prospectId} person={displayName ? { ...p, company: displayName } : p}
                    allUsers={accessUsers} selected={selected.has(p.prospectId)}
                    onNavigate={() => router.push(`/people/${p.prospectId}`)}
                    onSelect={(e) => handleSelectClick(p.prospectId, e)} onContext={(e) => personMenu.open(e, p)} />,
                );
                continue;
              }
              if (p.status === 'prospect') {
                rendered.push(
                  <PersonRow key={p.prospectId} person={p} allUsers={accessUsers} selected={selected.has(p.prospectId)}
                    onNavigate={() => router.push(`/people/${p.prospectId}`)}
                    onSelect={(e) => handleSelectClick(p.prospectId, e)} onContext={(e) => personMenu.open(e, p)} />,
                );
                continue;
              }
              const parentName     = p.clientName && parentMap.has(p.clientName) ? p.clientName : null;
              const parentClientId = parentName ? parentMap.get(parentName) : null;
              if (parentName && parentClientId) {
                if (seen.has(parentName)) continue;
                seen.add(parentName);
                const children = sorted.filter((c) => c.clientName === parentName);
                rendered.push(
                  <ParentRow key={`parent-${parentName}`} clientId={parentClientId} clientName={parentName}
                    children={children} onNavigate={() => router.push(`/people/org/${parentClientId}`)} />,
                );
              } else {
                rendered.push(
                  <PersonRow key={p.prospectId} person={p} allUsers={accessUsers} selected={selected.has(p.prospectId)}
                    onNavigate={() => router.push(`/people/${p.prospectId}`)}
                    onSelect={(e) => handleSelectClick(p.prospectId, e)} onContext={(e) => personMenu.open(e, p)} />,
                );
              }
            }
            return rendered;
          })()}
        </div>
      )}

      {/* Context menu */}
      {personMenu.menu && (
        <ContextMenu
          x={personMenu.menu.x}
          y={personMenu.menu.y}
          items={buildMenu(personMenu.menu.data)}
          onClose={personMenu.close}
        />
      )}

      {/* Rename modal */}
      {renaming && (
        <RenameModal
          title="Rename"
          label="Company name"
          initialValue={renaming.company}
          onSave={async (value) => { await apiRename(renaming.personId, value); setRenaming(null); }}
          onClose={() => setRenaming(null)}
        />
      )}

      {/* Archive confirm */}
      {confirmArchive && (
        <ConfirmModal
          title={confirmArchive.unarchive ? 'Unarchive?' : 'Archive?'}
          body={confirmArchive.unarchive
            ? `Restore "${confirmArchive.label}" to your active list?`
            : `Archive "${confirmArchive.label}"? You can restore it any time.`}
          confirmLabel={confirmArchive.unarchive ? 'Unarchive' : 'Archive'}
          onConfirm={async () => { await apiArchive(confirmArchive.ids, confirmArchive.unarchive); setConfirmArchive(null); }}
          onClose={() => setConfirmArchive(null)}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <ConfirmModal
          title="Delete?"
          body={`Permanently delete "${confirmDelete.label}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => { await apiDelete(confirmDelete.ids); setConfirmDelete(null); }}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {/* New person modal */}
      {showNew && (
        <NewPersonModal
          currentUserId={currentUserId}
          accessUsers={accessUsers}
          onClose={() => setShowNew(false)}
          onCreated={(p) => { setPeople((prev) => [p, ...prev]); setShowNew(false); }}
        />
      )}
    </div>
  );
}
