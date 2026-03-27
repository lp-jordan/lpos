'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useProjects } from '@/hooks/useProjects';
import { NewProjectModal } from '@/components/shared/NewProjectModal';
import { MediaDetailPanel } from '@/components/media/MediaDetailPanel';
import { GlobalSharesManager } from '@/components/media/GlobalSharesManager';
import type { Project } from '@/lib/models/project';
import type { MediaAsset } from '@/lib/models/media-asset';
import { FRAMEIO_STATUS_LABEL, LEADERPASS_STATUS_LABEL } from '@/lib/models/media-asset';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(b: number | null): string {
  if (b === null) return '—';
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function formatRelative(iso: string): string {
  try {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (d === 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 30)  return `${d}d ago`;
    if (d < 365) return `${Math.floor(d / 30)}mo ago`;
    return `${Math.floor(d / 365)}y ago`;
  } catch { return iso; }
}

// ── Status badges ─────────────────────────────────────────────────────────────

function TxBadge({ status }: { status: MediaAsset['transcription']['status'] }) {
  if (status === 'none') return <span />;
  const map: Record<Exclude<typeof status, 'none'>, [string, string]> = {
    queued:     ['gm-badge--pending', 'Queued'],
    processing: ['gm-badge--active',  'Transcribing…'],
    done:       ['gm-badge--success', 'Transcribed'],
    failed:     ['gm-badge--error',   'TX Failed'],
  };
  const [cls, label] = map[status];
  return <span className={`gm-badge ${cls}`}>{label}</span>;
}

function FioBadge({ status }: { status: MediaAsset['frameio']['status'] }) {
  if (status === 'none') return <span />;
  const cls: Record<Exclude<typeof status, 'none'>, string> = {
    uploading:     'gm-badge--active',
    in_review:     'gm-badge--review',
    approved:      'gm-badge--success',
    rejected:      'gm-badge--error',
    needs_changes: 'gm-badge--pending',
  };
  return <span className={`gm-badge ${cls[status]}`}>{FRAMEIO_STATUS_LABEL[status]}</span>;
}

function LeaderPassBadge({ status }: { status: MediaAsset['leaderpass']['status'] }) {
  if (status === 'none') return <span />;
  const map: Record<Exclude<typeof status, 'none'>, [string, string]> = {
    preparing:         ['gm-badge--active',  'Preparing…'],
    awaiting_platform: ['gm-badge--review',  'Awaiting'],
    published:         ['gm-badge--success', 'Published'],
    failed:            ['gm-badge--error',   'LP Failed'],
  };
  const [cls, label] = map[status];
  return <span className={`gm-badge ${cls}`}>{label}</span>;
}

// ── Asset row (inside an expanded project) ────────────────────────────────────

function AssetRow({
  asset,
  isOpen,
  onClick,
  onDeleteClick,
}: {
  asset:         MediaAsset;
  isOpen:        boolean;
  onClick:       () => void;
  onDeleteClick: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`gm-asset-row${isOpen ? ' gm-asset-row--open' : ''}`}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      {/* File icon */}
      <svg className="gm-asset-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <polygon points="10 11 16 14 10 17 10 11"/>
      </svg>

      <span className="gm-asset-name" title={asset.originalFilename}>
        {asset.name}
        {asset.name !== asset.originalFilename && (
          <span className="gm-asset-filename"> — {asset.originalFilename}</span>
        )}
      </span>

      <span className="gm-asset-size">{formatBytes(asset.fileSize)}</span>
      <span className="gm-asset-date">{formatDate(asset.registeredAt)}</span>
      <TxBadge  status={asset.transcription.status} />
      <FioBadge status={asset.frameio.status} />
      <LeaderPassBadge status={asset.leaderpass.status} />

      {/* Delete — stops propagation so it doesn't open the detail panel */}
      <button
        type="button"
        className="gm-asset-delete-btn"
        aria-label="Delete asset"
        title="Delete asset"
        onClick={onDeleteClick}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>
  );
}

// ── Sort header button ────────────────────────────────────────────────────────

function SortHeader({
  label, field, sortBy, sortDir, onSort,
}: {
  label:   string;
  field:   'name' | 'client' | 'updated';
  sortBy:  'name' | 'client' | 'updated';
  sortDir: 'asc' | 'desc';
  onSort:  (f: 'name' | 'client' | 'updated') => void;
}) {
  const active = sortBy === field;
  return (
    <button
      type="button"
      className={`gm-col-header-btn${active ? ' gm-col-header-btn--active' : ''}`}
      onClick={() => onSort(field)}
    >
      {label}
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="gm-sort-icon">
        {active && sortDir === 'asc'  && <polyline points="18 15 12 9 6 15"/>}
        {active && sortDir === 'desc' && <polyline points="6 9 12 15 18 9"/>}
        {!active && <><polyline points="18 15 12 9 6 15" opacity=".3"/><polyline points="6 16 12 22 18 16" opacity=".3"/></>}
      </svg>
    </button>
  );
}

// ── Project accordion row ─────────────────────────────────────────────────────

function ProjectAccordion({
  project,
  search,
  onAssetSelect,
  openAssetId,
  defaultExpanded,
  forceExpand,
}: {
  project:         Project;
  search:          string;
  onAssetSelect:   (asset: MediaAsset, projectId: string) => void;
  openAssetId:     string | null;
  defaultExpanded: boolean;
  forceExpand:     boolean;
}) {
  const router = useRouter();
  const [expanded,       setExpanded]       = useState(defaultExpanded);
  const [assets,         setAssets]         = useState<MediaAsset[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [fetched,        setFetched]        = useState(false);
  const [assetSort,      setAssetSort]      = useState<'name' | 'date'>('date');
  const [assetSortDir,   setAssetSortDir]   = useState<'asc' | 'desc'>('desc');
  const [pendingDelete,  setPendingDelete]  = useState<MediaAsset | null>(null);
  const [deleting,       setDeleting]       = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAssets = useCallback(async (force = false) => {
    if (fetched && !force) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/projects/${project.projectId}/media`);
      if (!res.ok) return;
      const data = await res.json() as { assets: MediaAsset[] };
      setAssets(data.assets);
      setFetched(true);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [project.projectId, fetched]);

  async function handleDeleteConfirm() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await fetch(
        `/api/projects/${project.projectId}/media/${pendingDelete.assetId}?deleteFile=true`,
        { method: 'DELETE' },
      );
      if (onAssetSelect && openAssetId === pendingDelete.assetId) {
        // Close the detail panel if this asset was open
        onAssetSelect(pendingDelete, project.projectId);
      }
      await fetchAssets(true);
    } catch { /* ignore */ }
    finally { setDeleting(false); setPendingDelete(null); }
  }

  // When search is active, force-expand and load assets for matching
  useEffect(() => {
    if (forceExpand) {
      setExpanded(true);
      void fetchAssets();
    }
  }, [forceExpand, fetchAssets]);

  // Expand + load when first opened
  function handleHeaderClick() {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      router.push(`/projects/${project.projectId}?from=media`);
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      const next = !expanded;
      setExpanded(next);
      if (next && !fetched) void fetchAssets();
    }, 220);
  }

  function toggleAssetSort(field: 'name' | 'date') {
    if (assetSort === field) setAssetSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setAssetSort(field); setAssetSortDir('asc'); }
  }

  // Filter then sort assets
  const filtered = (search
    ? assets.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.originalFilename.toLowerCase().includes(search.toLowerCase()),
      )
    : [...assets]
  ).sort((a, b) => {
    const cmp = assetSort === 'name'
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : new Date(a.registeredAt).getTime() - new Date(b.registeredAt).getTime();
    return assetSortDir === 'asc' ? cmp : -cmp;
  });

  const assetCount = fetched ? assets.length : null;

  // When searching, hide projects that have no matching assets (once loaded)
  if (forceExpand && fetched && filtered.length === 0) return null;

  return (
    <div className={`gm-project${expanded ? ' gm-project--open' : ''}`}>
      {/* Project header row */}
      <div
        role="button"
        tabIndex={0}
        className="gm-project-row"
        onClick={handleHeaderClick}
        onKeyDown={(e) => { if (e.key === 'Enter') handleHeaderClick(); }}
        title="Single click to expand · Double click to open project"
      >
        <svg
          className={`gm-chevron${expanded ? ' gm-chevron--open' : ''}`}
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
        >
          <polyline points="9 18 15 12 9 6"/>
        </svg>

        <span className="gm-project-name">{project.name}</span>
        <span className="gm-project-client">{project.clientName}</span>

        <span className="gm-project-updated">{formatRelative(project.updatedAt)}</span>

        {assetCount !== null && (
          <span className="gm-project-count">{assetCount} asset{assetCount !== 1 ? 's' : ''}</span>
        )}
      </div>

      {/* Expanded asset list */}
      {expanded && (
        <div className="gm-assets">
          {/* Asset sort bar */}
          {fetched && assets.length > 1 && (
            <div className="gm-asset-sort-bar">
              <span className="gm-asset-sort-label">Sort:</span>
              {(['name', 'date'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`gm-asset-sort-btn${assetSort === f ? ' gm-asset-sort-btn--active' : ''}`}
                  onClick={() => toggleAssetSort(f)}
                >
                  {f === 'name' ? 'Name' : 'Date uploaded'}
                  {assetSort === f && (
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      {assetSortDir === 'asc' ? <polyline points="18 15 12 9 6 15"/> : <polyline points="6 9 12 15 18 9"/>}
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {loading && <p className="gm-loading">Loading assets…</p>}
          {!loading && fetched && filtered.length === 0 && (
            <p className="gm-empty-assets">
              {assets.length === 0 ? 'No assets in this project yet.' : 'No assets match your search.'}
            </p>
          )}
          {filtered.map((asset) => (
            <AssetRow
              key={asset.assetId}
              asset={asset}
              isOpen={asset.assetId === openAssetId}
              onClick={() => onAssetSelect(asset, project.projectId)}
              onDeleteClick={(e) => { e.stopPropagation(); setPendingDelete(asset); }}
            />
          ))}
        </div>
      )}

      {/* Delete confirm overlay */}
      {pendingDelete && (
        <div className="gm-delete-confirm" role="dialog" aria-modal>
          <p className="gm-delete-confirm-msg">
            Permanently delete <strong>{pendingDelete.name}</strong>
            {pendingDelete.frameio?.assetId ? ' and remove it from Frame.io' : ''}?
            {' '}This cannot be undone.
          </p>
          <div className="gm-delete-confirm-actions">
            <button
              type="button"
              className="gm-delete-confirm-cancel"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="gm-delete-confirm-ok"
              onClick={() => void handleDeleteConfirm()}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MediaPage() {
  const { projects, loading } = useProjects();

  const [tab,          setTab]          = useState<'projects' | 'shares'>('projects');
  const [search,       setSearch]       = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [sortBy,       setSortBy]       = useState<'name' | 'client' | 'updated'>('updated');
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('desc');
  const [showNewModal, setShowNewModal] = useState(false);

  // Detail panel state
  const [panelAsset,     setPanelAsset]     = useState<MediaAsset | null>(null);
  const [panelProjectId, setPanelProjectId] = useState<string>('');

  function handleAssetSelect(asset: MediaAsset, projectId: string) {
    setPanelAsset(asset);
    setPanelProjectId(projectId);
  }

  function handlePanelClose() {
    setPanelAsset(null);
    setPanelProjectId('');
  }

  function handleSort(field: 'name' | 'client' | 'updated') {
    if (sortBy === field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir(field === 'updated' ? 'desc' : 'asc'); }
  }

  // Unique sorted client names for the filter dropdown
  const clientNames = Array.from(
    new Set(projects.map((p: Project) => p.clientName ?? '').filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) as string[];

  // Filter by client only — search works at the asset level inside each accordion
  const filteredProjects = projects
    .filter((p: Project) => {
      if (clientFilter && (p.clientName ?? '') !== clientFilter) return false;
      return true;
    })
    .sort((a: Project, b: Project) => {
      let cmp = 0;
      if (sortBy === 'name')    cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      if (sortBy === 'client')  cmp = (a.clientName ?? '').localeCompare(b.clientName ?? '', undefined, { numeric: true });
      if (sortBy === 'updated') cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      return sortDir === 'asc' ? cmp : -cmp;
    });

  // Auto-expand the first project when there's only one
  const singleProject = projects.length === 1;

  return (
    <div className="page-stack">
      {/* Tab bar */}
      <div className="gm-tabs">
        <button
          type="button"
          className={`gm-tab${tab === 'projects' ? ' gm-tab--active' : ''}`}
          onClick={() => setTab('projects')}
        >
          Projects
        </button>
        <button
          type="button"
          className={`gm-tab${tab === 'shares' ? ' gm-tab--active' : ''}`}
          onClick={() => setTab('shares')}
        >
          Share Links
        </button>
      </div>

      {tab === 'shares' && <GlobalSharesManager />}

      {tab === 'projects' && <>
      {/* Toolbar */}
      <div className="gm-toolbar">
        <div className="gm-toolbar-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            className="gm-search"
            type="text"
            placeholder="Search assets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="gm-search-clear" type="button" onClick={() => setSearch('')} aria-label="Clear">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        {/* Client filter */}
        {clientNames.length > 1 && (
          <div className="gm-client-filter">
            <select
              className="gm-client-select"
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              aria-label="Filter by client"
            >
              <option value="">All clients</option>
              {clientNames.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {clientFilter && (
              <button
                type="button"
                className="gm-search-clear"
                onClick={() => setClientFilter('')}
                aria-label="Clear client filter"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>
        )}

        <button className="gm-new-btn" type="button" onClick={() => setShowNewModal(true)}>
          + New Project
        </button>
      </div>

      {/* Column headers — clickable to sort */}
      {filteredProjects.length > 0 && (
        <div className="gm-col-headers">
          <span />
          <SortHeader label="Project" field="name"    sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
          <SortHeader label="Client"  field="client"  sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
          <SortHeader label="Updated" field="updated" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
        </div>
      )}

      {/* States */}
      {loading && <p className="m-empty">Loading…</p>}

      {!loading && projects.length === 0 && (
        <div className="proj-empty-state">
          <p>No projects yet.</p>
          <button type="button" className="gm-new-btn" onClick={() => setShowNewModal(true)}>
            Create your first project
          </button>
        </div>
      )}

      {!loading && projects.length > 0 && filteredProjects.length === 0 && (
        <p className="m-empty">No projects match the selected filter.</p>
      )}

      {/* Accordion list */}
      {!loading && filteredProjects.length > 0 && (
        <div className="gm-list">
          {filteredProjects.map((p) => (
            <ProjectAccordion
              key={p.projectId}
              project={p}
              search={search}
              onAssetSelect={handleAssetSelect}
              openAssetId={panelAsset?.assetId ?? null}
              defaultExpanded={singleProject}
              forceExpand={!!search}
            />
          ))}
        </div>
      )}

      </>}

      {/* Detail panel — rendered outside tabs so it can overlay either view */}
      <MediaDetailPanel
        asset={panelAsset}
        projectId={panelProjectId}
        onClose={handlePanelClose}
        onUpdated={() => {}}
      />

      {showNewModal && (
        <NewProjectModal
          onClose={() => setShowNewModal(false)}
          onCreated={() => setShowNewModal(false)}
        />
      )}
    </div>
  );
}
