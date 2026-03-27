'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { Project } from '@/lib/models/project';
import { Asset } from '@/lib/models/asset';
import { io } from 'socket.io-client';
import { MediaTab } from '@/components/projects/MediaTab';
import { ScriptsTab } from '@/components/projects/ScriptsTab';
import { PassPrepTab } from '@/components/projects/PassPrepTab';
import { ClientAssetsTab } from '@/components/projects/ClientAssetsTab';
import { TranscriptViewerPanel } from '@/components/media/TranscriptViewerPanel';
import type { TranscriptEntry } from '@/app/api/projects/[projectId]/transcripts/route';

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function formatTranscriptLabel(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

type Tab = 'scripts' | 'media' | 'transcripts' | 'passPrep' | 'clientAssets';

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
  const [tab, setTab] = useState<Tab>('media');
  const [passPrepTranscripts, setPassPrepTranscripts] = useState<string[]>([]);
  const [selectedTranscriptJobId, setSelectedTranscriptJobId] = useState<string | null>(null);
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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'clientAssets', label: 'Client Assets' },
    { id: 'scripts', label: 'Scripts' },
    { id: 'media', label: 'Media' },
    { id: 'transcripts', label: 'Transcripts' },
    { id: 'passPrep', label: 'Pass Prep' },
  ];

  useEffect(() => {
    if (deepLinkedAssetId) setTab('media');
  }, [deepLinkedAssetId]);

  return (
    <div className="page-stack">
      <div className="project-header">
        <span className="project-header-client">{project.clientName}</span>
        <h1 className="project-header-name">{project.name}</h1>
        <div className="project-header-meta">
          <span>{project.createdAt}</span>
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
  const [panelMode, setPanelMode] = useState<'viewer' | 'search' | null>(null);
  const [viewerJobId, setViewerJobId] = useState<string | null>(null);
  const [viewerFilename, setViewerFilename] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchScopeJobIds, setSearchScopeJobIds] = useState<string[] | null>(null);
  const [searchSessionKey, setSearchSessionKey] = useState(0);

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

  function getTranscriptFileUrl(jobId: string, type: 'txt' | 'json' | 'srt' | 'vtt'): string {
    return `/api/projects/${projectId}/transcripts?download=${jobId}&type=${type}`;
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
      prev.size === transcripts.length
        ? new Set()
        : new Set(transcripts.map((entry) => entry.jobId))
    ));
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

  const nextSelectedScope = selected.size > 0 ? [...selected].sort() : null;
  const appliedScope = searchScopeJobIds ? [...searchScopeJobIds].sort() : null;
  const canUseSelectedScope = JSON.stringify(nextSelectedScope) !== JSON.stringify(appliedScope);

  if (loading) return <p className="m-empty">Loading...</p>;

  return (
    <div className="proj-tab-content page-stack" style={{ position: 'relative' }}>
      {transcripts.length > 0 && (
        <div className="proj-transcript-toolbar">
          <div className="proj-transcript-toolbar-actions">
            {transcripts.length > 1 ? (
              <label className="proj-transcript-select-all">
                <input
                  type="checkbox"
                  checked={selected.size > 0 && selected.size === transcripts.length}
                  onChange={toggleSelectAll}
                />
                <span>Select all</span>
              </label>
            ) : (
              <span />
            )}

            <button type="button" className="proj-file-action proj-file-action--primary" onClick={() => openSearch()}>
              Content Search
            </button>
          </div>

          {transcripts.length > 1 && selected.size >= 2 && (
            <>
              <div className="proj-bulk-bar proj-transcript-bulk-bar">
                <span className="proj-bulk-count">{selected.size} selected</span>
                <div className="proj-bulk-actions">
                  <button
                    type="button"
                    className="proj-bulk-btn"
                    disabled
                    title="Batch Pass Prep is not wired yet."
                  >
                    Pass Prep
                  </button>
                </div>
                <button type="button" className="proj-bulk-clear" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {transcripts.length > 0 ? (
        <div className="proj-file-list">
          {transcripts.map((entry) => (
            <div
              key={entry.jobId}
              className={`proj-file-row proj-file-row--transcript${viewerJobId === entry.jobId && panelMode === 'viewer' ? ' proj-file-row--active' : ''}${selected.has(entry.jobId) ? ' proj-row--selected' : ''}`}
            >
              <button
                type="button"
                className="proj-transcript-check"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelect(entry.jobId);
                }}
                aria-label={selected.has(entry.jobId) ? `Deselect ${formatTranscriptLabel(entry.filename)}` : `Select ${formatTranscriptLabel(entry.filename)}`}
              >
                <Checkbox checked={selected.has(entry.jobId)} />
              </button>

              <button
                type="button"
                className="proj-file-row-btn"
                onClick={() => openViewer(entry)}
                aria-label={`View TXT transcript for ${formatTranscriptLabel(entry.filename)}`}
              >
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
              </button>

              <div className="proj-file-actions">
                <a
                  href={getTranscriptFileUrl(entry.jobId, 'txt')}
                  className="proj-file-action"
                  download
                  onClick={(event) => event.stopPropagation()}
                >
                  TXT
                </a>
                {entry.files.json && (
                  <a
                    href={getTranscriptFileUrl(entry.jobId, 'json')}
                    className="proj-file-action"
                    download
                    onClick={(event) => event.stopPropagation()}
                  >
                    JSON
                  </a>
                )}
                {entry.files.srt && (
                  <a
                    href={getTranscriptFileUrl(entry.jobId, 'srt')}
                    className="proj-file-action"
                    download
                    onClick={(event) => event.stopPropagation()}
                  >
                    SRT
                  </a>
                )}
                {entry.files.vtt && (
                  <a
                    href={getTranscriptFileUrl(entry.jobId, 'vtt')}
                    className="proj-file-action"
                    download
                    onClick={(event) => event.stopPropagation()}
                  >
                    VTT
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
