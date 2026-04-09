'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useContextMenu } from '@/contexts/ContextMenuContext';
import type { TranscriptEntry } from '@/lib/transcripts/types';

interface Props {
  projectId: string;
  initialTranscripts: TranscriptEntry[];
  onOpen?: (entry: TranscriptEntry) => void;
}

export function TranscriptOutputList({ projectId, initialTranscripts, onOpen }: Readonly<Props>) {
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>(initialTranscripts);
  const [selectedIds, setSelectedIds]  = useState<Set<string>>(new Set());
  const lastSelectedIdx                = useRef<number>(-1);
  const listRef                        = useRef<HTMLDivElement>(null);

  const { openMenu } = useContextMenu();
  const router       = useRouter();

  // Deselect when clicking outside the list
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        setSelectedIds(new Set());
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/transcripts`);
    if (!res.ok) return;
    const data = await res.json() as { transcripts: TranscriptEntry[] };
    setTranscripts(data.transcripts);
  }, [projectId]);

  // ── Selection ────────────────────────────────────────────────────────────

  function handleClick(entry: TranscriptEntry, idx: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(entry.jobId)) { next.delete(entry.jobId); }
        else { next.add(entry.jobId); }
        return next;
      });
      lastSelectedIdx.current = idx;
      return;
    }

    if (e.shiftKey && lastSelectedIdx.current !== -1) {
      const from = Math.min(lastSelectedIdx.current, idx);
      const to   = Math.max(lastSelectedIdx.current, idx);
      setSelectedIds(new Set(transcripts.slice(from, to + 1).map((t) => t.jobId)));
      return;
    }

    setSelectedIds(new Set([entry.jobId]));
    lastSelectedIdx.current = idx;
  }

  function handleOpen(entry: TranscriptEntry) {
    onOpen?.(entry);
  }

  // ── Delete ───────────────────────────────────────────────────────────────

  async function deleteJobIds(jobIds: string[], label: string) {
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    await fetch(`/api/projects/${projectId}/transcripts`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds }),
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of jobIds) next.delete(id);
      return next;
    });
    await refresh();
  }

  // ── Download ─────────────────────────────────────────────────────────────

  function download(jobId: string, type: 'txt' | 'json' | 'srt' | 'vtt') {
    const a = document.createElement('a');
    a.href = `/api/projects/${projectId}/transcripts?download=${jobId}&type=${type}`;
    a.download = '';
    a.click();
  }

  // ── Context menu ─────────────────────────────────────────────────────────

  function handleContextMenu(entry: TranscriptEntry, idx: number, e: React.MouseEvent) {
    e.preventDefault();

    if (!selectedIds.has(entry.jobId)) {
      setSelectedIds(new Set([entry.jobId]));
      lastSelectedIdx.current = idx;
    }

    const isMulti  = selectedIds.has(entry.jobId) && selectedIds.size > 1;
    const count    = isMulti ? selectedIds.size : 1;
    const jobIds   = isMulti ? [...selectedIds] : [entry.jobId];
    const deleteLabel = count > 1 ? `${count} transcripts` : `"${entry.filename}"`;

    openMenu(e.clientX, e.clientY, [
      ...(!isMulti ? [
        {
          type: 'item' as const,
          label: 'Download TXT',
          icon: <DownloadIcon />,
          onClick: () => download(entry.jobId, 'txt'),
        },
        {
          type: 'item' as const,
          label: 'Download JSON',
          icon: <DownloadIcon />,
          disabled: !entry.files.json,
          onClick: () => download(entry.jobId, 'json'),
        },
        {
          type: 'item' as const,
          label: 'Download SRT',
          icon: <DownloadIcon />,
          disabled: !entry.files.srt,
          onClick: () => download(entry.jobId, 'srt'),
        },
        {
          type: 'item' as const,
          label: 'Download VTT',
          icon: <DownloadIcon />,
          disabled: !entry.files.vtt,
          onClick: () => download(entry.jobId, 'vtt'),
        },
        { type: 'separator' as const },
        {
          type: 'item' as const,
          label: 'Open Source Media',
          icon: <MediaIcon />,
          disabled: !entry.assetId,
          onClick: () => router.push(`/projects/${projectId}/media`),
        },
        { type: 'separator' as const },
      ] : []),
      {
        type: 'item' as const,
        label: count > 1 ? `Delete ${count} transcripts` : 'Delete',
        icon: <TrashIcon />,
        danger: true,
        onClick: () => { void deleteJobIds(jobIds, deleteLabel); },
      },
    ]);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (transcripts.length === 0) {
    return (
      <div className="transcript-output-list">
        <article className="transcript-output-card">
          <div className="row-head">
            <strong>Main interview transcript.json</strong>
            <span className="tag">Transcript JSON</span>
          </div>
          <div className="row-meta"><span>Status: Waiting for first run</span></div>
        </article>
        <article className="transcript-output-card">
          <div className="row-head">
            <strong>Main interview subtitles.srt</strong>
            <span className="tag">Subtitle export</span>
          </div>
          <div className="row-meta"><span>Status: Waiting for first run</span></div>
        </article>
      </div>
    );
  }

  return (
    <div className="transcript-output-list" ref={listRef}>
      {transcripts.map((entry, idx) => (
        <article
          key={entry.jobId}
          className={[
            'transcript-output-card transcript-output-card--interactive',
            selectedIds.has(entry.jobId) ? 'transcript-output-card--selected' : '',
          ].filter(Boolean).join(' ')}
          onClick={(e) => handleClick(entry, idx, e)}
          onDoubleClick={() => handleOpen(entry)}
          onContextMenu={(e) => handleContextMenu(entry, idx, e)}
          role="row"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleOpen(entry); }
            if (e.key === ' ')     { e.preventDefault(); handleClick(entry, idx, e as unknown as React.MouseEvent); }
          }}
        >
          <div className="row-head">
            <strong>{entry.filename}</strong>
            <span className="tag">{formatFileList(entry.files)}</span>
          </div>
          <div className="row-meta">
            <span>{formatBytes(entry.txtSize)}</span>
            <span>{formatDate(entry.completedAt)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFileList(files: TranscriptEntry['files']): string {
  return [
    files.txt  && 'TXT',
    files.json && 'JSON',
    files.srt  && 'SRT',
    files.vtt  && 'VTT',
  ].filter(Boolean).join(' · ');
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return iso; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function MediaIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
      <line x1="7" y1="2" x2="7" y2="22"/>
      <line x1="17" y1="2" x2="17" y2="22"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <line x1="2" y1="7" x2="7" y2="7"/>
      <line x1="2" y1="17" x2="7" y2="17"/>
      <line x1="17" y1="17" x2="22" y2="17"/>
      <line x1="17" y1="7" x2="22" y2="7"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
    </svg>
  );
}
