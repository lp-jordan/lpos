'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useProjects } from '@/hooks/useProjects';
import { NewProjectModal } from '@/components/shared/NewProjectModal';
import { RenameModal } from '@/components/shared/RenameModal';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { ContextMenu } from '@/components/shared/ContextMenu';
import type { MenuEntry } from '@/components/shared/ContextMenu';
import { useContextMenu } from '@/hooks/useContextMenu';
import type { Project } from '@/lib/models/project';

type ViewMode = 'card' | 'list';

// ── Date helpers ──────────────────────────────────────────────────────────────

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const ms = new Date(iso).getTime();
    if (isNaN(ms)) return '';
    const diff  = Date.now() - ms;
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

// ── SVG icon helpers ──────────────────────────────────────────────────────────

function IconOpen()    { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>; }
function IconPencil()  { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>; }
function IconArchive() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>; }
function IconTrash()   { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>; }
function IconUnarchive() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><polyline points="10 12 12 10 14 12"/><line x1="12" y1="10" x2="12" y2="16"/></svg>; }

// ── Checkbox ──────────────────────────────────────────────────────────────────

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span className={`proj-check${checked ? ' proj-check--checked' : ''}`} aria-hidden="true">
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="2 6 5 9 10 3" />
      </svg>
    </span>
  );
}

// ── View toggle ───────────────────────────────────────────────────────────────

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

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiPatch(projectId: string, patch: Partial<Project>) {
  const res = await fetch(`/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const d = await res.json() as { error?: string };
    throw new Error(d.error ?? 'Request failed');
  }
}

async function apiDelete(projectId: string) {
  const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Delete failed');
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const router = useRouter();
  const { projects } = useProjects();

  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [activeClient, setActiveClient] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  // Modals
  const [showNewModal, setShowNewModal] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; currentName: string; isClient?: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<{ ids: string[]; label: string; unarchive?: boolean } | null>(null);

  // Context menus
  const projectMenu = useContextMenu<Project>();
  const clientMenu  = useContextMenu<string>();

  // ── Derived data ────────────────────────────────────────────────────────────

  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  const visibleProjects = showArchived ? archivedProjects : activeProjects;

  const clients = Array.from(new Set(activeProjects.map((p) => p.clientName))).sort();

  const clientProjects = activeClient
    ? visibleProjects.filter((p) => p.clientName === activeClient)
    : [];

  const filteredClients = clients.filter((c) =>
    !search || c.toLowerCase().includes(search.toLowerCase())
  );

  const filteredClientProjects = clientProjects.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  // ── Selection helpers ───────────────────────────────────────────────────────

  function toggleSelect(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setLastSelectedId(id);
  }

  function rangeSelect(id: string, orderedIds: string[]) {
    if (!lastSelectedId) { toggleSelect(id); return; }
    const a = orderedIds.indexOf(lastSelectedId);
    const b = orderedIds.indexOf(id);
    if (a === -1 || b === -1) { toggleSelect(id); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return next;
    });
    setLastSelectedId(id);
  }

  function clearSelection() {
    setSelected(new Set());
    setLastSelectedId(null);
  }

  function handleProjectClick(e: React.MouseEvent, project: Project, orderedIds: string[]) {
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(project.projectId, e);
    } else if (e.shiftKey) {
      e.preventDefault();
      rangeSelect(project.projectId, orderedIds);
    } else if (selected.size > 0) {
      toggleSelect(project.projectId, e);
    } else {
      router.push(`/projects/${project.projectId}`);
    }
  }

  // ── Bulk actions ────────────────────────────────────────────────────────────

  async function bulkDelete(ids: string[]) {
    await Promise.all(ids.map(apiDelete));
    setSelected((prev) => { const n = new Set(prev); ids.forEach((id) => n.delete(id)); return n; });
  }

  async function bulkArchive(ids: string[], unarchive = false) {
    await Promise.all(ids.map((id) => apiPatch(id, { archived: !unarchive })));
    clearSelection();
  }

  // ── Rename helpers ──────────────────────────────────────────────────────────

  async function saveRename(value: string) {
    if (!renaming) return;
    if (renaming.isClient) {
      // Rename client: patch all projects with that clientName
      const toRename = projects.filter((p) => p.clientName === renaming.currentName);
      await Promise.all(toRename.map((p) => apiPatch(p.projectId, { clientName: value })));
      if (activeClient === renaming.currentName) setActiveClient(value);
    } else {
      await apiPatch(renaming.id, { name: value });
    }
  }

  // ── Project context menu builder ────────────────────────────────────────────

  const buildProjectMenu = useCallback((project: Project): MenuEntry[] => [
    {
      type: 'item',
      label: 'Open',
      icon: <IconOpen />,
      onClick: () => router.push(`/projects/${project.projectId}`),
    },
    {
      type: 'item',
      label: 'Rename',
      icon: <IconPencil />,
      onClick: () => setRenaming({ id: project.projectId, currentName: project.name }),
    },
    { type: 'separator' },
    project.archived
      ? {
          type: 'item',
          label: 'Unarchive',
          icon: <IconUnarchive />,
          onClick: () => setConfirmArchive({ ids: [project.projectId], label: project.name, unarchive: true }),
        }
      : {
          type: 'item',
          label: 'Archive',
          icon: <IconArchive />,
          onClick: () => setConfirmArchive({ ids: [project.projectId], label: project.name }),
        },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Delete',
      icon: <IconTrash />,
      danger: true,
      onClick: () => setConfirmDelete({ ids: [project.projectId], label: `"${project.name}"` }),
    },
  ], [router]);

  // ── Client context menu builder ─────────────────────────────────────────────

  const buildClientMenu = useCallback((clientName: string): MenuEntry[] => {
    const clientProjs = projects.filter((p) => p.clientName === clientName);
    return [
      {
        type: 'item',
        label: 'Open',
        icon: <IconOpen />,
        onClick: () => { setActiveClient(clientName); setSearch(''); },
      },
      {
        type: 'item',
        label: 'Rename Client',
        icon: <IconPencil />,
        onClick: () => setRenaming({ id: '', currentName: clientName, isClient: true }),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: `Delete All ${clientProjs.length} Project${clientProjs.length !== 1 ? 's' : ''}`,
        icon: <IconTrash />,
        danger: true,
        disabled: clientProjs.length === 0,
        onClick: () => setConfirmDelete({
          ids: clientProjs.map((p) => p.projectId),
          label: `all projects in "${clientName}"`,
        }),
      },
    ];
  }, [projects]);

  // ── Client drill-in view ────────────────────────────────────────────────────

  if (activeClient) {
    const orderedIds = filteredClientProjects.map((p) => p.projectId);

    return (
      <div className="page-stack">
        {/* Controls */}
        <div className="proj-controls">
          <button
            className="proj-back-btn"
            type="button"
            onClick={() => { setActiveClient(null); setSearch(''); clearSelection(); }}
            aria-label="Back to clients"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <input
            className="proj-search"
            type="text"
            placeholder={`Search ${activeClient} projects…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="proj-controls-right">
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            <button type="button" className="proj-new-btn" onClick={() => setShowNewModal(true)}>
              + New Project
            </button>
          </div>
        </div>

        {/* Bulk bar */}
        {selected.size > 0 && (
          <div className="proj-bulk-bar">
            <span className="proj-bulk-count">{selected.size} selected</span>
            <div className="proj-bulk-actions">
              <button
                type="button"
                className="proj-bulk-btn"
                onClick={() => setConfirmArchive({
                  ids: Array.from(selected),
                  label: `${selected.size} project${selected.size !== 1 ? 's' : ''}`,
                })}
              >
                Archive
              </button>
              <button
                type="button"
                className="proj-bulk-btn proj-bulk-btn--danger"
                onClick={() => setConfirmDelete({
                  ids: Array.from(selected),
                  label: `${selected.size} project${selected.size !== 1 ? 's' : ''}`,
                })}
              >
                Delete
              </button>
            </div>
            <button type="button" className="proj-bulk-clear" onClick={clearSelection}>
              Clear selection
            </button>
          </div>
        )}

        {/* Client header */}
        <div className="proj-client-header">
          <h1 className="proj-client-title">{activeClient}</h1>
          <span className="proj-client-count">
            {clientProjects.length} project{clientProjects.length !== 1 ? 's' : ''}
          </span>
          {archivedProjects.filter((p) => p.clientName === activeClient).length > 0 && (
            <button
              type="button"
              className="proj-archived-toggle"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? 'Hide archived' : `Show archived (${archivedProjects.filter((p) => p.clientName === activeClient).length})`}
            </button>
          )}
        </div>

        {/* Empty state */}
        {clientProjects.length === 0 && (
          <div className="proj-empty-state">
            <p>No projects yet for {activeClient}.</p>
            <button type="button" className="proj-new-btn" onClick={() => setShowNewModal(true)}>
              Create first project
            </button>
          </div>
        )}

        {/* Card grid */}
        {viewMode === 'card' && filteredClientProjects.length > 0 && (
          <div className="proj-grid">
            {filteredClientProjects.map((p) => (
              <ProjectCard
                key={p.projectId}
                project={p}
                selected={selected.has(p.projectId)}
                selectionActive={selected.size > 0}
                onClick={(e) => handleProjectClick(e, p, orderedIds)}
                onToggle={(e) => toggleSelect(p.projectId, e)}
                onContextMenu={(e) => { projectMenu.open(e, p); }}
              />
            ))}
          </div>
        )}

        {/* List view */}
        {viewMode === 'list' && filteredClientProjects.length > 0 && (
          <div className="proj-list">
            {filteredClientProjects.map((p) => (
              <ProjectRow
                key={p.projectId}
                project={p}
                selected={selected.has(p.projectId)}
                selectionActive={selected.size > 0}
                onClick={(e) => handleProjectClick(e, p, orderedIds)}
                onToggle={(e) => toggleSelect(p.projectId, e)}
                onContextMenu={(e) => { projectMenu.open(e, p); }}
              />
            ))}
          </div>
        )}

        {/* No results */}
        {clientProjects.length > 0 && filteredClientProjects.length === 0 && (
          <p className="m-empty">No projects match your search.</p>
        )}

        {/* Context menu */}
        {projectMenu.menu && (
          <ContextMenu
            x={projectMenu.menu.x}
            y={projectMenu.menu.y}
            items={buildProjectMenu(projectMenu.menu.data)}
            onClose={projectMenu.close}
          />
        )}

        {/* Modals */}
        {showNewModal && (
          <NewProjectModal
            defaultClientName={activeClient}
            onClose={() => setShowNewModal(false)}
            onCreated={() => setShowNewModal(false)}
          />
        )}
        <Modals
          renaming={renaming}
          confirmDelete={confirmDelete}
          confirmArchive={confirmArchive}
          onCloseRename={() => setRenaming(null)}
          onSaveRename={saveRename}
          onCloseDelete={() => setConfirmDelete(null)}
          onConfirmDelete={() => bulkDelete(confirmDelete!.ids)}
          onCloseArchive={() => setConfirmArchive(null)}
          onConfirmArchive={() => bulkArchive(confirmArchive!.ids, confirmArchive?.unarchive)}
        />
      </div>
    );
  }

  // ── Top level: clients ────────────────────────────────────────────────────

  return (
    <div className="page-stack">
      {/* Controls */}
      <div className="proj-controls">
        <input
          className="proj-search"
          type="text"
          placeholder="Search clients…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="proj-controls-right">
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          <button type="button" className="proj-new-btn" onClick={() => setShowNewModal(true)}>
            + New Client
          </button>
        </div>
      </div>

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="proj-empty-state">
          <p>No clients yet.</p>
          <button type="button" className="proj-new-btn" onClick={() => setShowNewModal(true)}>
            Create your first client
          </button>
        </div>
      )}

      {/* Client cards */}
      {viewMode === 'card' && filteredClients.length > 0 && (
        <div className="proj-client-grid">
          {filteredClients.map((client) => {
            const count = activeProjects.filter((p) => p.clientName === client).length;
            return (
              <ClientCard
                key={client}
                clientName={client}
                count={count}
                onClick={() => { setActiveClient(client); setSearch(''); }}
                onContextMenu={(e) => { clientMenu.open(e, client); }}
              />
            );
          })}
        </div>
      )}

      {/* Client list */}
      {viewMode === 'list' && filteredClients.length > 0 && (
        <div className="proj-list">
          {filteredClients.map((client) => {
            const count = activeProjects.filter((p) => p.clientName === client).length;
            return (
              <ClientRow
                key={client}
                clientName={client}
                count={count}
                onClick={() => { setActiveClient(client); setSearch(''); }}
                onContextMenu={(e) => { clientMenu.open(e, client); }}
              />
            );
          })}
        </div>
      )}

      {/* No results */}
      {projects.length > 0 && filteredClients.length === 0 && (
        <p className="m-empty">No clients match your search.</p>
      )}

      {/* Client context menu */}
      {clientMenu.menu && (
        <ContextMenu
          x={clientMenu.menu.x}
          y={clientMenu.menu.y}
          items={buildClientMenu(clientMenu.menu.data)}
          onClose={clientMenu.close}
        />
      )}

      {/* Modals */}
      {showNewModal && (
        <NewProjectModal
          onClose={() => setShowNewModal(false)}
          onCreated={() => setShowNewModal(false)}
        />
      )}
      <Modals
        renaming={renaming}
        confirmDelete={confirmDelete}
        confirmArchive={confirmArchive}
        onCloseRename={() => setRenaming(null)}
        onSaveRename={saveRename}
        onCloseDelete={() => setConfirmDelete(null)}
        onConfirmDelete={() => bulkDelete(confirmDelete!.ids)}
        onCloseArchive={() => setConfirmArchive(null)}
        onConfirmArchive={() => bulkArchive(confirmArchive!.ids, confirmArchive?.unarchive)}
      />
    </div>
  );
}

// ── Shared modal block ────────────────────────────────────────────────────────

function Modals({
  renaming, confirmDelete, confirmArchive,
  onCloseRename, onSaveRename,
  onCloseDelete, onConfirmDelete,
  onCloseArchive, onConfirmArchive,
}: {
  renaming: { id: string; currentName: string; isClient?: boolean } | null;
  confirmDelete: { ids: string[]; label: string } | null;
  confirmArchive: { ids: string[]; label: string; unarchive?: boolean } | null;
  onCloseRename: () => void;
  onSaveRename: (value: string) => Promise<void>;
  onCloseDelete: () => void;
  onConfirmDelete: () => Promise<void>;
  onCloseArchive: () => void;
  onConfirmArchive: () => Promise<void>;
}) {
  return (
    <>
      {renaming && (
        <RenameModal
          title={renaming.isClient ? 'Rename Client' : 'Rename Project'}
          label={renaming.isClient ? 'Client Name' : 'Project Name'}
          initialValue={renaming.currentName}
          onSave={onSaveRename}
          onClose={onCloseRename}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete Project"
          body={`Permanently delete ${confirmDelete.label}? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => { await onConfirmDelete(); onCloseDelete(); }}
          onClose={onCloseDelete}
        />
      )}
      {confirmArchive && (
        <ConfirmModal
          title={confirmArchive.unarchive ? 'Unarchive' : 'Archive'}
          body={
            confirmArchive.unarchive
              ? `Restore ${confirmArchive.label} to your active projects?`
              : `Archive ${confirmArchive.label}? You can restore it any time.`
          }
          confirmLabel={confirmArchive.unarchive ? 'Unarchive' : 'Archive'}
          onConfirm={async () => { await onConfirmArchive(); onCloseArchive(); }}
          onClose={onCloseArchive}
        />
      )}
    </>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: Project;
  selected: boolean;
  selectionActive: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggle: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function ProjectCard({ project: p, selected, selectionActive, onClick, onToggle, onContextMenu }: Readonly<ProjectItemProps>) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`proj-card proj-card--selectable${selected ? ' proj-card--selected' : ''}${p.archived ? ' proj-card--archived' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(e as unknown as React.MouseEvent); }}
    >
      {/* Selection checkbox — top-left corner */}
      <button
        type="button"
        className={`proj-check-wrap${selectionActive ? ' proj-check-wrap--visible' : ''}`}
        onClick={onToggle}
        aria-label={selected ? 'Deselect' : 'Select'}
      >
        <Checkbox checked={selected} />
      </button>

      {p.archived && <span className="proj-archived-badge">Archived</span>}

      {/* Thumbnail — loads lazily from Frame.io, hidden on error */}
      <div className="proj-card-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/projects/${p.projectId}/thumbnail`}
          alt=""
          loading="lazy"
          draggable={false}
          onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }}
        />
      </div>

      {/* Bottom: project name + created date */}
      <div className="proj-card-body">
        <h2 className="proj-card-name">{p.name}</h2>
      </div>

      <div className="proj-card-footer">
        <span className="proj-card-footer-date" title={`Created ${formatShortDate(p.createdAt)}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          {formatShortDate(p.createdAt)}
        </span>
        <span className="proj-card-footer-updated" title={`Created ${formatRelativeDate(p.createdAt)}`}>
          {formatRelativeDate(p.createdAt)}
        </span>
      </div>
    </div>
  );
}

// ── Project row ───────────────────────────────────────────────────────────────

function ProjectRow({ project: p, selected, selectionActive, onClick, onToggle, onContextMenu }: Readonly<ProjectItemProps>) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`proj-row proj-row--selectable${selected ? ' proj-row--selected' : ''}${p.archived ? ' proj-row--archived' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(e as unknown as React.MouseEvent); }}
    >
      <button
        type="button"
        className={`proj-check-wrap${selectionActive ? ' proj-check-wrap--visible' : ''}`}
        onClick={onToggle}
        aria-label={selected ? 'Deselect' : 'Select'}
      >
        <Checkbox checked={selected} />
      </button>
      <span className="proj-row-name">{p.name}</span>
      <div className="proj-indicators proj-indicators--inline" />
      <span className="proj-row-date">{p.createdAt}</span>
      {p.archived && <span className="proj-archived-badge proj-archived-badge--inline">Archived</span>}
      <svg className="proj-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  );
}

// ── Client card ───────────────────────────────────────────────────────────────

function ClientCard({ clientName, count, onClick, onContextMenu }: {
  clientName: string; count: number;
  onClick: () => void; onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className="proj-client-card"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="proj-client-card-initial">{clientName.charAt(0).toUpperCase()}</span>
      <span className="proj-client-card-name">{clientName}</span>
      <span className="proj-client-card-count">{count} project{count !== 1 ? 's' : ''}</span>
      <svg className="proj-client-card-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}

// ── Client row ────────────────────────────────────────────────────────────────

function ClientRow({ clientName, count, onClick, onContextMenu }: {
  clientName: string; count: number;
  onClick: () => void; onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className="proj-client-row"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="proj-client-row-initial">{clientName.charAt(0).toUpperCase()}</span>
      <span className="proj-client-row-name">{clientName}</span>
      <span className="proj-client-row-count">{count} project{count !== 1 ? 's' : ''}</span>
      <svg className="proj-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}
