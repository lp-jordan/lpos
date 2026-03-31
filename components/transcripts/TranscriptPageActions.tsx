'use client';

import { useState } from 'react';

interface Props {
  projectId: string;
  hasTranscripts: boolean;
}

export function TranscriptPageActions({ projectId, hasTranscripts }: Readonly<Props>) {
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<number | null>(null);

  async function clearDuplicates() {
    setClearing(true);
    setClearResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/transcripts/clear-duplicates`, { method: 'POST' });
      const data = await res.json() as { cleared?: number };
      setClearResult(data.cleared ?? 0);
    } catch {
      setClearResult(0);
    } finally {
      setClearing(false);
    }
  }

  async function deleteAll() {
    if (!confirm('Delete all transcripts for this project? This cannot be undone.')) return;
    setDeleting(true);
    setDeleteResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/transcripts/delete-all`, { method: 'POST' });
      const data = await res.json() as { deleted?: number };
      setDeleteResult(data.deleted ?? 0);
    } catch {
      setDeleteResult(0);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="transcript-page-actions">
      <a
        href={`/api/projects/${projectId}/transcripts/download-all`}
        download
        className={`btn-secondary${!hasTranscripts ? ' btn--disabled' : ''}`}
        aria-disabled={!hasTranscripts}
        onClick={(e) => { if (!hasTranscripts) e.preventDefault(); }}
      >
        Download all transcripts
      </a>
      <button
        type="button"
        className="btn-secondary btn--destructive"
        onClick={() => void clearDuplicates()}
        disabled={clearing || !hasTranscripts}
      >
        {clearing ? 'Clearing…' : clearResult !== null ? `Cleared ${clearResult}` : 'Clear duplicates'}
      </button>
      <button
        type="button"
        className="btn-secondary btn--destructive"
        onClick={() => void deleteAll()}
        disabled={deleting || !hasTranscripts}
      >
        {deleting ? 'Deleting…' : deleteResult !== null ? `Deleted ${deleteResult}` : 'Delete all'}
      </button>
    </div>
  );
}
