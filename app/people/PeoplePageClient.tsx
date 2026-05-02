'use client';

import { useState } from 'react';
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

type ViewMode    = 'card' | 'list';
type ScopeFilter = 'mine' | 'all';
type TabFilter   = 'prospects' | 'active' | 'all';

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<ProspectStatus, { bg: string; border: string; color: string }> = {
  prospect: { bg: 'rgba(91,141,217,0.15)',  border: '#5b8dd9', color: '#5b8dd9' },
  active:   { bg: 'rgba(90,185,90,0.15)',   border: '#5ab95a', color: '#5ab95a' },
  inactive: { bg: 'rgba(120,120,120,0.15)', border: '#888',    color: '#888'    },
};

const STATUS_LABELS: Record<ProspectStatus, string> = {
  prospect: 'Prospect',
  active:   'Active',
  inactive: 'Inactive',
};

function StatusBadge({ status }: { status: ProspectStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{
      display: 'inline-block', padding: '0.2rem 0.55rem', borderRadius: '999px',
      border: `1px solid ${s.border}`, backgroundColor: s.bg, color: s.color,
      fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em', whiteSpace: 'nowrap',
    }}>
      {STATUS_LABELS[status]}
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
        <StatusBadge status={person.status} />
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
      <StatusBadge status={person.status} />
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

// ── Main page ─────────────────────────────────────────────────────────────────

interface Props {
  initialPeople:     Prospect[];
  currentUserId:     string;
  accessUsers:       UserSummary[];
  lastUpdateBodies?: Record<string, string>;
}

export function PeoplePageClient({ initialPeople, currentUserId, accessUsers, lastUpdateBodies }: Props) {
  const router = useRouter();

  const [people,       setPeople]       = useState<Prospect[]>(initialPeople);
  const [search,       setSearch]       = useState('');
  const [viewMode,     setViewMode]     = useState<ViewMode>('card');
  const [scope,        setScope]        = useState<ScopeFilter>('all');
  const [tab,          setTab]          = useState<TabFilter>('prospects');
  const [showArchived, setShowArchived] = useState(false);
  const [showNew,      setShowNew]      = useState(false);

  const [selected,       setSelected]       = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  const [renaming,       setRenaming]       = useState<{ personId: string; company: string } | null>(null);
  const [confirmDelete,  setConfirmDelete]  = useState<{ ids: string[]; label: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<{ ids: string[]; label: string; unarchive?: boolean } | null>(null);

  const personMenu = useContextMenu<Prospect>();

  // ── Derived ────────────────────────────────────────────────────────────────

  const tabFiltered = people.filter((p) => {
    if (tab === 'prospects') return p.status === 'prospect';
    if (tab === 'active')    return p.status === 'active' || p.status === 'inactive';
    return true;
  });

  const filtered = tabFiltered.filter((p) => {
    if (!showArchived && p.archived)                                       return false;
    if (showArchived  && !p.archived)                                      return false;
    if (scope === 'mine' && !p.assignedTo.includes(currentUserId))        return false;
    if (search && !p.company.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const filteredIds   = filtered.map((p) => p.prospectId);
  const archivedCount = tabFiltered.filter((p) => p.archived).length;

  const prospectCount = people.filter((p) => p.status === 'prospect' && !p.archived).length;
  const activeCount   = people.filter((p) => (p.status === 'active' || p.status === 'inactive') && !p.archived).length;

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
    const items: MenuEntry[] = [
      {
        type: 'item', label: 'Open',
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
        onClick: () => router.push(`/people/${p.prospectId}`),
      },
    ];
    if (p.status !== 'active') {
      items.push({
        type: 'item', label: 'Rename',
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
        onClick: () => setRenaming({ personId: p.prospectId, company: p.company }),
      });
      items.push({ type: 'separator' });
      items.push({
        type: 'item', label: p.archived ? 'Unarchive' : 'Archive',
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
        onClick: () => setConfirmArchive({ ids: [p.prospectId], label: p.company, unarchive: p.archived }),
      });
      items.push({ type: 'separator' });
      items.push({
        type: 'item', label: 'Delete', danger: true,
        icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
        onClick: () => setConfirmDelete({ ids: [p.prospectId], label: p.company }),
      });
    }
    return items;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page-stack">
      {/* Controls */}
      <div className="proj-controls">
        <input
          className="proj-search"
          type="text"
          placeholder="Search people…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="proj-controls-right">
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          <button type="button" className="proj-new-btn" onClick={() => setShowNew(true)}>
            + New
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="proj-filter-pills" style={{ marginRight: '0.5rem' }}>
          <button
            type="button"
            className={`proj-filter-pill${tab === 'prospects' ? ' active' : ''}`}
            onClick={() => { setTab('prospects'); setShowArchived(false); setSelected(new Set()); }}
          >
            Prospects{prospectCount > 0 ? ` (${prospectCount})` : ''}
          </button>
          <button
            type="button"
            className={`proj-filter-pill${tab === 'active' ? ' active' : ''}`}
            onClick={() => { setTab('active'); setShowArchived(false); setSelected(new Set()); }}
          >
            Clients{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
          <button
            type="button"
            className={`proj-filter-pill${tab === 'all' ? ' active' : ''}`}
            onClick={() => { setTab('all'); setShowArchived(false); setSelected(new Set()); }}
          >
            All
          </button>
        </div>

        <div className="proj-filter-pills">
          <button type="button" className={`proj-filter-pill${scope === 'all' ? ' active' : ''}`} onClick={() => setScope('all')}>Everyone</button>
          <button type="button" className={`proj-filter-pill${scope === 'mine' ? ' active' : ''}`} onClick={() => setScope('mine')}>Mine</button>
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
            const ids = Array.from(selected).filter((id) => {
              const p = people.find((x) => x.prospectId === id);
              return p && p.status !== 'active';
            });
            if (ids.length > 0) void apiArchive(ids);
          }}
          onDelete={() => {
            const ids = Array.from(selected).filter((id) => {
              const p = people.find((x) => x.prospectId === id);
              return p && p.status !== 'active';
            });
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

      {people.length > 0 && filtered.length === 0 && (
        <p className="m-empty">No results match your filters.</p>
      )}

      {/* Card view */}
      {viewMode === 'card' && filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filtered.map((p) => (
            <PersonCard
              key={p.prospectId}
              person={p}
              allUsers={accessUsers}
              lastUpdate={lastUpdateBodies?.[p.prospectId]}
              selected={selected.has(p.prospectId)}
              onNavigate={() => router.push(`/people/${p.prospectId}`)}
              onSelect={(e) => handleSelectClick(p.prospectId, e)}
              onContext={(e) => personMenu.open(e, p)}
            />
          ))}
        </div>
      )}

      {/* List view */}
      {viewMode === 'list' && filtered.length > 0 && (
        <div className="proj-list">
          {filtered.map((p) => (
            <PersonRow
              key={p.prospectId}
              person={p}
              allUsers={accessUsers}
              selected={selected.has(p.prospectId)}
              onNavigate={() => router.push(`/people/${p.prospectId}`)}
              onSelect={(e) => handleSelectClick(p.prospectId, e)}
              onContext={(e) => personMenu.open(e, p)}
            />
          ))}
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
          body={`Permanently delete "${confirmDelete.label}"? This cannot be undone. Active clients cannot be deleted.`}
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
