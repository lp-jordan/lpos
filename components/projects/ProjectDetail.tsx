'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Project } from '@/lib/models/project';
import { Asset } from '@/lib/models/asset';
import { io } from 'socket.io-client';
import { MediaTab } from '@/components/projects/MediaTab';
import { ScriptsTab } from '@/components/projects/ScriptsTab';
import { PassPrepTab } from '@/components/projects/PassPrepTab';
import { ClientAssetsTab } from '@/components/projects/ClientAssetsTab';
import { AssetsTab } from '@/components/projects/AssetsTab';
import { TranscriptViewerPanel } from '@/components/media/TranscriptViewerPanel';
import type { TranscriptEntry } from '@/app/api/projects/[projectId]/transcripts/route';
import { useContextMenu } from '@/contexts/ContextMenuContext';

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function formatTranscriptLabel(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

type Tab = 'scripts' | 'media' | 'transcripts' | 'assets' | 'passPrep' | 'clientAssets';

interface Props {
  project: Project;
  assets: Asset[];
}

function Checkbox({ checked }: Readonly<{ checked: boolean }>) {
  return (
    <span className={`proj-check${checked ? ' proj-check--checked' : ''}`} aria-hidden="true">
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="2 6 5 9 10 3" />
      </svg>
    </span>
  );
}

export function ProjectDetail({ project, assets }: Readonly<Props>) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('media');
  const [passPrepTranscripts, setPassPrepTranscripts] = useState<string[]>([]);
  const [selectedTranscriptJobId, setSelectedTranscriptJobId] = useState<string | null>(null);
  const [sentScriptAssetIds, setSentScriptAssetIds] = useState<Set<string>>(new Set());
  const deepLinkedAssetId = searchParams.get('assetId');

  const workbooks = assets.filter((asset) => asset.type === 'workbook');

  function sendToPassPrep(jobId: string) {
    setPassPrepTranscripts((prev) => prev.includes(jobId) ? prev : [...prev, jobId]);
    setTab('passPrep');
  }

  function handleGoToTranscript(jobId: string) {
    setSelectedTranscriptJobId(jobId);
    setTab('transcripts');
  }

  function handleSendToScripts(asset: { entityId: string }) {
    setSentScriptAssetIds((prev) => new Set([...prev, asset.entityId]));
    setTab('scripts');
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'clientAssets', label: 'Client Uploads' },
    { id: 'scripts',      label: 'Scripts' },
    { id: 'media',        label: 'Media' },
    { id: 'transcripts',  label: 'Transcripts' },
    { id: 'assets',       label: 'Assets' },
    { id: 'passPrep',     label: 'Pass Prep' },
  ];

  useEffect(() => {
    if (deepLinkedAssetId) setTab('media');
  }, [deepLinkedAssetId]);

  const clientParam = searchParams.get('client');
  const backHref = clientParam ? `/projects?client=${encodeURIComponent(clientParam)}` : '/projects';

  return (
    <div className="page-stack">
      <div className="project-header">
        <button
          type="button"
          className="proj-back-btn"
          onClick={() => router.push(backHref)}
          aria-label="Back to projects"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div>
          <span className="project-header-client">{project.clientName}</span>
          <h1 className="project-header-name">{project.name}</h1>
          <div className="project-header-meta">
            <span>{project.createdAt}</span>
          </div>
        </div>
      </div>

      <div className="proj-tabs">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`proj-tab${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'scripts' && <ScriptsTab projectId={project.projectId} />}

      {tab === 'media' && (
        <MediaTab
          projectId={project.projectId}
          projectName={project.name}
          deepLinkedAssetId={deepLinkedAssetId}
          onGoToTranscript={handleGoToTranscript}
        />
      )}

      {tab === 'transcripts' && (
        <TranscriptsTab
          projectId={project.projectId}
          projectName={project.name}
          passPrepIds={passPrepTranscripts}
          onSendToPassPrep={sendToPassPrep}
          selectedJobId={selectedTranscriptJobId}
          onClearSelectedJobId={() => setSelectedTranscriptJobId(null)}
        />
      )}

      {tab === 'assets' && <AssetsTab projectId={project.projectId} projectName={project.name} sentScriptIds={sentScriptAssetIds} onSendToScripts={handleSendToScripts} />}

      {tab === 'passPrep' && (
        <PassPrepTab
          workbooks={workbooks}
          projectId={project.projectId}
          queuedJobIds={passPrepTranscripts}
        />
      )}

      {tab === 'clientAssets' && (
        <ClientAssetsTab
          projectId={project.projectId}
          projectName={project.name}
          clientName={project.clientName}
        />
      )}
    </div>
  );
}

function TranscriptsTab({
  projectId,
  projectName,
  passPrepIds,
  onSendToPassPrep,
  selectedJobId,
  onClearSelectedJobId,
}: {
  projectId: string;
  projectName: string;
  passPrepIds: string[];
  onSendToPassPrep: (jobId: string) => void;
  selectedJobId?: string | null;
  onClearSelectedJobId?: () => void;
}) {
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<'date-desc' | 'date-asc' | 'name-asc' | 'name-desc'>('date-desc');
  const [panelMode, setPanelMode] = useState<'viewer' | 'search' | null>(null);
  const [viewerJobId, setViewerJobId] = useState<string | null>(null);
  const [viewerFilename, setViewerFilename] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchScopeJobIds, setSearchScopeJobIds] = useState<string[] | null>(null);
  const [searchSessionKey, setSearchSessionKey] = useState(0);
  const [deleting, setDeleting] = useState(false);

  const lastSelectedIdx = useRef<number>(-1);
  const listRef          = useRef<HTMLDivElement>(null);
  const { openMenu }     = useContextMenu();
  const router           = useRouter();

  const fetchTranscripts = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/transcripts`);
      if (!res.ok) return;
      const data = await res.json() as { transcripts: TranscriptEntry[] };
      setTranscripts(data.transcripts);
    } catch {
      // Ignore list refresh errors.
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void fetchTranscripts(); }, [fetchTranscripts]);

  useEffect(() => {
    const socket = io('/transcripter', { transports: ['websocket'] });
    socket.on('queue', () => { void fetchTranscripts(); });
    return () => { socket.disconnect(); };
  }, [fetchTranscripts]);

  function getTranscriptFileUrl(jobId: string, type: 'txt' | 'json' | 'srt' | 'vtt' | 'timecoded-txt'): string {
    return `/api/projects/${projectId}/transcripts?download=${jobId}&type=${type}`;
  }

  async function batchDownload(type: 'txt' | 'timecoded-txt') {
    const entries = displayedTranscripts.filter((e) => selected.has(e.jobId));
    const eligible = type === 'timecoded-txt' ? entries.filter((e) => e.files.json) : entries;
    for (let i = 0; i < eligible.length; i++) {
      const entry = eligible[i]!;
      const a = document.createElement('a');
      a.href = getTranscriptFileUrl(entry.jobId, type);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (i < eligible.length - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  function openViewer(entry: TranscriptEntry) {
    setViewerJobId(entry.jobId);
    setViewerFilename(formatTranscriptLabel(entry.filename));
    setPanelMode('viewer');
  }

  function closePanel() {
    setViewerJobId(null);
    setViewerFilename('');
    setPanelMode(null);
  }

  function openSearch(optionalEntry?: TranscriptEntry) {
    const nextScope = optionalEntry
      ? [optionalEntry.jobId]
      : (selected.size > 0 ? [...selected] : null);
    setSearchScopeJobIds(nextScope);
    setPanelMode('search');
    setSearchSessionKey((value) => value + 1);
  }

  function applySelectedScopeToSearch() {
    setSearchScopeJobIds(selected.size > 0 ? [...selected] : null);
    setPanelMode('search');
    setSearchSessionKey((value) => value + 1);
  }

  function toggleSelect(jobId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (
      prev.size === displayedTranscripts.length && displayedTranscripts.every((e) => prev.has(e.jobId))
        ? new Set()
        : new Set(displayedTranscripts.map((entry) => entry.jobId))
    ));
  }

  async function deleteJobIds(jobIds: string[]) {
    if (!confirm(`Delete ${jobIds.length} transcript${jobIds.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/projects/${projectId}/transcripts`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds }),
      });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of jobIds) next.delete(id);
        return next;
      });
      void fetchTranscripts();
    } finally {
      setDeleting(false);
    }
  }

  // ── Click-away deselect ───────────────────────────────────────────────────

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        setSelected(new Set());
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ── Row interaction ───────────────────────────────────────────────────────

  function handleRowClick(entry: TranscriptEntry, idx: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(entry.jobId);
      lastSelectedIdx.current = idx;
      return;
    }
    if (e.shiftKey && lastSelectedIdx.current !== -1) {
      e.preventDefault();
      const from = Math.min(lastSelectedIdx.current, idx);
      const to   = Math.max(lastSelectedIdx.current, idx);
      setSelected(new Set(displayedTranscripts.slice(from, to + 1).map((t) => t.jobId)));
      return;
    }
    // Deselect if already sole selection, otherwise select only this
    if (selected.has(entry.jobId) && selected.size === 1) {
      setSelected(new Set());
    } else {
      setSelected(new Set([entry.jobId]));
      lastSelectedIdx.current = idx;
    }
  }

  function download(jobId: string, type: 'txt' | 'json' | 'srt' | 'vtt' | 'timecoded-txt') {
    const a = document.createElement('a');
    a.href = getTranscriptFileUrl(jobId, type);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function openTranscriptMenu(entry: TranscriptEntry, idx: number, e: React.MouseEvent) {
    e.preventDefault();
    if (!selected.has(entry.jobId)) {
      setSelected(new Set([entry.jobId]));
      lastSelectedIdx.current = idx;
    }
    const isMulti = selected.has(entry.jobId) && selected.size > 1;
    const count   = isMulti ? selected.size : 1;
    const jobIds  = isMulti ? [...selected] : [entry.jobId];

    openMenu(e.clientX, e.clientY, [
      ...(!isMulti ? [
        {
          type: 'item' as const,
          label: 'Open',
          icon: <TrOpenIcon />,
          onClick: () => openViewer(entry),
        },
        { type: 'separator' as const },
        {
          type: 'item' as const,
          label: 'Download TXT',
          icon: <TrDownloadIcon />,
          onClick: () => download(entry.jobId, 'txt'),
        },
        {
          type: 'item' as const,
          label: 'Download Timecoded',
          icon: <TrDownloadIcon />,
          disabled: !entry.files.json,
          onClick: () => download(entry.jobId, 'timecoded-txt'),
        },
        {
          type: 'item' as const,
          label: 'Download SRT',
          icon: <TrDownloadIcon />,
          disabled: !entry.files.srt,
          onClick: () => download(entry.jobId, 'srt'),
        },
        {
          type: 'item' as const,
          label: 'Download VTT',
          icon: <TrDownloadIcon />,
          disabled: !entry.files.vtt,
          onClick: () => download(entry.jobId, 'vtt'),
        },
        { type: 'separator' as const },
        {
          type: 'item' as const,
          label: 'Open Source Media',
          icon: <TrMediaIcon />,
          disabled: !entry.assetId,
          onClick: () => router.push(`/projects/${projectId}/media`),
        },
        {
          type: 'item' as const,
          label: passPrepIds.includes(entry.jobId) ? '✓ In Pass Prep' : '→ Pass Prep',
          icon: <TrPassPrepIcon />,
          disabled: passPrepIds.includes(entry.jobId),
          onClick: () => onSendToPassPrep(entry.jobId),
        },
        { type: 'separator' as const },
      ] : []),
      {
        type: 'item' as const,
        label: count > 1 ? `Delete ${count} transcripts` : 'Delete',
        icon: <TrTrashIcon />,
        danger: true,
        onClick: () => { void deleteJobIds(jobIds); },
      },
    ]);
  }

  useEffect(() => {
    if (!selectedJobId || loading) return;
    const entry = transcripts.find((transcript) => transcript.jobId === selectedJobId);
    if (entry) {
      openViewer(entry);
      onClearSelectedJobId?.();
    }
  }, [selectedJobId, transcripts, loading, onClearSelectedJobId]);

  const activeSearchScope = useMemo(() => {
    if (!searchScopeJobIds || searchScopeJobIds.length === 0) return transcripts;
    const scopeSet = new Set(searchScopeJobIds);
    return transcripts.filter((entry) => scopeSet.has(entry.jobId));
  }, [searchScopeJobIds, transcripts]);

  const displayedTranscripts = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    const filtered = needle
      ? transcripts.filter((entry) =>
          formatTranscriptLabel(entry.filename).toLowerCase().includes(needle),
        )
      : transcripts;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'date-asc':  return new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime();
        case 'name-asc':  return formatTranscriptLabel(a.filename).localeCompare(formatTranscriptLabel(b.filename), undefined, { numeric: true, sensitivity: 'base' });
        case 'name-desc': return formatTranscriptLabel(b.filename).localeCompare(formatTranscriptLabel(a.filename), undefined, { numeric: true, sensitivity: 'base' });
        default:          return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
      }
    });
  }, [transcripts, filterText, sortKey]);

  const nextSelectedScope = selected.size > 0 ? [...selected].sort() : null;
  const appliedScope = searchScopeJobIds ? [...searchScopeJobIds].sort() : null;
  const canUseSelectedScope = JSON.stringify(nextSelectedScope) !== JSON.stringify(appliedScope);

  if (loading) return <p className="m-empty">Loading...</p>;

  return (
    <div className="proj-tab-content page-stack" style={{ position: 'relative' }} ref={listRef}>
      {transcripts.length > 0 && (
        <div className="proj-transcript-toolbar">
          <div className="proj-transcript-toolbar-actions">
            {transcripts.length > 1 ? (
              <label className="proj-transcript-select-all">
                <input
                  type="checkbox"
                  checked={displayedTranscripts.length > 0 && displayedTranscripts.every((e) => selected.has(e.jobId))}
                  onChange={toggleSelectAll}
                />
                <span>Select all</span>
              </label>
            ) : (
              <span />
            )}

            <div className="proj-transcript-filter-row">
              <input
                type="search"
                className="proj-transcript-filter-input"
                placeholder="Filter by name…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              <select
                className="proj-transcript-sort-select"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
                aria-label="Sort transcripts"
              >
                <option value="date-desc">Newest first</option>
                <option value="date-asc">Oldest first</option>
                <option value="name-asc">Name A–Z</option>
                <option value="name-desc">Name Z–A</option>
              </select>
            </div>

            <button type="button" className="proj-file-action proj-file-action--primary" onClick={() => openSearch()}>
              Content Search
            </button>
          </div>

          {transcripts.length > 1 && (
            <>
              <div className={`proj-bulk-bar-wrap${selected.size === 0 ? ' proj-bulk-bar-wrap--empty' : ''}`}>
              <div className="proj-bulk-bar proj-transcript-bulk-bar">
                <span className="proj-bulk-count">{selected.size} selected</span>
                <div className="proj-bulk-actions">
                  <button
                    type="button"
                    className="proj-bulk-btn"
                    onClick={() => void batchDownload('txt')}
                  >
                    Download TXT
                  </button>
                  <button
                    type="button"
                    className="proj-bulk-btn"
                    onClick={() => void batchDownload('timecoded-txt')}
                    disabled={displayedTranscripts.filter((e) => selected.has(e.jobId) && e.files.json).length === 0}
                    title="Downloads timecoded TXT for selected transcripts that have a JSON source"
                  >
                    Download Timecoded
                  </button>
                  <button
                    type="button"
                    className="proj-bulk-btn"
                    disabled
                    title="Batch Pass Prep is not wired yet."
                  >
                    Pass Prep
                  </button>
                  <button
                    type="button"
                    className="proj-bulk-btn proj-bulk-btn--danger"
                    onClick={() => void deleteJobIds([...selected])}
                    disabled={deleting}
                  >
                    {deleting ? 'Deleting…' : `Delete${selected.size > 1 ? ` ${selected.size}` : ''}`}
                  </button>
                </div>
                <button type="button" className="proj-bulk-clear" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </div>
              </div>
            </>
          )}
        </div>
      )}

      {transcripts.length > 0 ? (
        <div className="proj-file-list">
          {displayedTranscripts.length === 0 && (
            <p className="m-empty">No transcripts match &ldquo;{filterText}&rdquo;.</p>
          )}
          {displayedTranscripts.map((entry, idx) => (
            <div
              key={entry.jobId}
              className={[
                'proj-file-row proj-file-row--transcript proj-file-row--clickable',
                viewerJobId === entry.jobId && panelMode === 'viewer' ? 'proj-file-row--active' : '',
                selected.has(entry.jobId) ? 'proj-file-row--selected' : '',
              ].filter(Boolean).join(' ')}
              onClick={(e) => handleRowClick(entry, idx, e)}
              onDoubleClick={() => openViewer(entry)}
              onContextMenu={(e) => openTranscriptMenu(entry, idx, e)}
              role="row"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') openViewer(entry); }}
            >
              <button
                type="button"
                className="proj-transcript-check"
                onClick={(e) => { e.stopPropagation(); toggleSelect(entry.jobId); }}
                aria-label={selected.has(entry.jobId) ? `Deselect ${formatTranscriptLabel(entry.filename)}` : `Select ${formatTranscriptLabel(entry.filename)}`}
              >
                <Checkbox checked={selected.has(entry.jobId)} />
              </button>

              <div className="proj-file-row-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                <div className="proj-file-info">
                  <span className="proj-file-name">{formatTranscriptLabel(entry.filename)}</span>
                  <span className="proj-file-date">{formatDate(entry.completedAt)}</span>
                </div>
              </div>

              <div className="proj-file-actions" onClick={(e) => e.stopPropagation()}>
                <a
                  href={getTranscriptFileUrl(entry.jobId, 'txt')}
                  className="proj-file-action"
                  download
                >
                  TXT
                </a>
                {entry.files.json && (
                  <a
                    href={getTranscriptFileUrl(entry.jobId, 'timecoded-txt')}
                    className="proj-file-action"
                    download
                  >
                    Timecoded
                  </a>
                )}
                <button
                  type="button"
                  className={`proj-file-action proj-file-action--primary${passPrepIds.includes(entry.jobId) ? ' sent' : ''}`}
                  onClick={() => onSendToPassPrep(entry.jobId)}
                  disabled={passPrepIds.includes(entry.jobId)}
                >
                  {passPrepIds.includes(entry.jobId) ? '✓ In Pass Prep' : '→ Pass Prep'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="m-empty">No transcripts yet. Upload a video in the Media tab.</p>
      )}

      <TranscriptViewerPanel
        projectId={projectId}
        projectName={projectName}
        mode={panelMode === 'search' ? 'search' : 'viewer'}
        jobId={panelMode === 'viewer' ? viewerJobId : null}
        filename={viewerFilename}
        onClose={closePanel}
        standalone
        searchScope={activeSearchScope.map((entry) => ({ jobId: entry.jobId, filename: entry.filename }))}
        searchScopeMode={searchScopeJobIds && searchScopeJobIds.length > 0 ? 'selected' : 'all'}
        searchSessionKey={searchSessionKey}
        canUseSelectedScope={canUseSelectedScope}
        onUseSelectedScope={applySelectedScopeToSearch}
        onNewChat={() => setSearchSessionKey((value) => value + 1)}
        onApplyThreadScope={(scope) => {
          setSearchScopeJobIds(scope.mode === 'all' || scope.jobIds.length === 0 ? null : scope.jobIds);
          setPanelMode('search');
        }}
        onOpenTranscript={(jobId, transcriptFilename) => {
          const entry = transcripts.find((item) => item.jobId === jobId);
          if (entry) openViewer(entry);
          else {
            setViewerJobId(jobId);
            setViewerFilename(formatTranscriptLabel(transcriptFilename));
            setPanelMode('viewer');
          }
        }}
        onStartSearchFromTranscript={() => {
          const current = transcripts.find((item) => item.jobId === viewerJobId);
          if (current) openSearch(current);
        }}
      />
    </div>
  );
}

// ── Icons (transcript context menu) ──────────────────────────────────────────

function TrOpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  );
}

function TrDownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function TrMediaIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
    </svg>
  );
}

function TrPassPrepIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}

function TrTrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
    </svg>
  );
}
