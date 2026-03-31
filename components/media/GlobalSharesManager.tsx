'use client';

import { useState, useEffect, useCallback } from 'react';
import type { GlobalShareProject } from '@/app/api/shares/route';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

// ── Share row ─────────────────────────────────────────────────────────────────

function ShareRow({ share, projectId }: { share: GlobalShareProject['shares'][number]; projectId: string }) {
  const [copied,   setCopied]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted,  setDeleted]  = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(share.shareUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDelete() {
    if (!confirm(`Delete "${share.name}"? The link will stop working.`)) return;
    setDeleting(true);
    try {
      const url = projectId === '__unassigned__'
        ? `/api/shares/${share.id}`
        : `/api/projects/${projectId}/shares/${share.id}`;
      await fetch(url, { method: 'DELETE' });
      setDeleted(true);
    } catch { /* ignore */ } finally { setDeleting(false); }
  }

  if (deleted) return null;

  const countLabel = share.fileCount === null
    ? '—'
    : `${share.fileCount} file${share.fileCount !== 1 ? 's' : ''}`;

  return (
    <div className="gsm-share-row">
      <div className="gsm-share-info">
        <span className="gsm-share-name">{share.name}</span>
        <span className="gsm-share-meta">
          {formatDate(share.createdAt)}
          {' · '}
          {countLabel}
        </span>
        <span className="gsm-share-url">{share.shareUrl}</span>
      </div>
      <div className="gsm-share-actions">
        <a
          href={share.shareUrl}
          target="_blank"
          rel="noreferrer"
          className="sh-card-action-btn"
          title="Open in Frame.io"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Open
        </a>
        <button
          type="button"
          className={`sh-card-action-btn${copied ? ' sh-card-action-btn--success' : ' sh-card-action-btn--accent'}`}
          onClick={handleCopy}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          {copied ? '✓' : 'Copy'}
        </button>
        <button
          type="button"
          className="sh-card-action-btn sh-card-action-btn--danger"
          onClick={() => void handleDelete()}
          disabled={deleting}
          title="Delete share"
          aria-label="Delete share"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Project group ─────────────────────────────────────────────────────────────

function ProjectGroup({ group }: { group: GlobalShareProject }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="gsm-project-group">
      <button
        type="button"
        className="gsm-project-header"
        onClick={() => setCollapsed((v) => !v)}
      >
        <svg
          className={`sh-chevron${collapsed ? '' : ' sh-chevron--open'}`}
          width="11" height="11" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
        >
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span className="gsm-project-name">{group.projectName}</span>
        {group.clientName && (
          <span className="gsm-project-client">{group.clientName}</span>
        )}
        <span className="gsm-project-count">
          {group.shares.length} share{group.shares.length !== 1 ? 's' : ''}
        </span>
      </button>

      {!collapsed && (
        <div className="gsm-project-shares">
          {group.shares.map((s) => (
            <ShareRow key={s.id} share={s} projectId={group.projectId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── GlobalSharesManager ───────────────────────────────────────────────────────

export interface ProjectFilterOption {
  projectId:   string;
  projectName: string;
  clientName:  string;
}

export function GlobalSharesManager({ projects }: { projects?: ProjectFilterOption[] }) {
  const [groups,         setGroups]         = useState<GlobalShareProject[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [projectFilter,  setProjectFilter]  = useState<string>('');

  const fetchShares = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/shares');
      const data = await res.json() as { projects?: GlobalShareProject[]; error?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to load shares'); return; }
      setGroups(data.projects ?? []);
    } catch {
      setError('Network error — could not load shares');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchShares(); }, [fetchShares]);

  const filteredGroups = projectFilter
    ? groups.filter((g) => g.projectId === projectFilter)
    : groups;

  const totalShares = filteredGroups.reduce((n, g) => n + g.shares.length, 0);

  // Build sorted project options from fetched groups (or from the prop if provided)
  const projectOptions: ProjectFilterOption[] = projects
    ? projects
    : groups
        .filter((g) => g.projectId !== '__unassigned__')
        .map((g) => ({ projectId: g.projectId, projectName: g.projectName, clientName: g.clientName }));

  return (
    <div className="gsm-root">
      <div className="gsm-toolbar">
        <span className="gsm-title">
          {loading ? 'Loading…' : `${totalShares} share link${totalShares !== 1 ? 's' : ''} across ${filteredGroups.length} project${filteredGroups.length !== 1 ? 's' : ''}`}
        </span>

        {projectOptions.length > 0 && (
          <select
            className="gsm-project-filter"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {projectOptions.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.clientName ? `${p.clientName} — ${p.projectName}` : p.projectName}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className="sh-icon-btn"
          onClick={() => void fetchShares()}
          title="Refresh"
          aria-label="Refresh shares"
          disabled={loading}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
      </div>

      {error && <p className="sh-error">{error}</p>}

      {!loading && !error && filteredGroups.length === 0 && (
        <p className="m-empty">
          {projectFilter ? 'No share links for this project.' : 'No share links found. Create them from a project\'s Shares panel.'}
        </p>
      )}

      {filteredGroups.map((g) => (
        <ProjectGroup key={g.projectId} group={g} />
      ))}
    </div>
  );
}
