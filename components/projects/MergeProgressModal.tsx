'use client';

import { useState, useEffect } from 'react';

// ── Types (mirrors server-side; defined here to avoid server module imports) ──

type MergeJobStatus =
  | 'pending'
  | 'scanning'
  | 'awaiting_resolution'
  | 'merging'
  | 'completed'
  | 'failed';

type ConflictResolution = 'keep_source' | 'keep_target' | 'keep_both';

interface ConflictFile {
  filename:         string;
  sourceFileId:     string;
  sourceModifiedAt: string | null;
  sourceSize:       number | null;
  targetFileId:     string;
  targetModifiedAt: string | null;
  targetSize:       number | null;
}

interface JobState {
  jobId:        string;
  status:       MergeJobStatus;
  conflicts?:   ConflictFile[];
  errorMessage?: string;
  completedAt?:  string;
}

// ── Status label / color ──────────────────────────────────────────────────────

const STATUS_LABEL: Record<MergeJobStatus, string> = {
  pending:              'Waiting to start…',
  scanning:             'Scanning files…',
  awaiting_resolution:  'Conflicts found — resolve below',
  merging:              'Merging…',
  completed:            'Done',
  failed:               'Failed',
};

// ── Conflict resolution panel ─────────────────────────────────────────────────

function ConflictResolutionPanel({
  conflicts,
  resolutions,
  onSet,
  onSubmit,
  submitting,
}: {
  conflicts:   ConflictFile[];
  resolutions: Record<string, ConflictResolution>;
  onSet:       (filename: string, value: ConflictResolution) => void;
  onSubmit:    () => void;
  submitting:  boolean;
}) {
  const allResolved = conflicts.every((c) => !!resolutions[c.filename]);

  function formatSize(n: number | null) {
    if (!n) return '';
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
  function formatDate(iso: string | null) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return ''; }
  }

  return (
    <div className="conflict-panel">
      <p className="conflict-panel-intro">
        {conflicts.length} file{conflicts.length !== 1 ? 's' : ''} exist in both folders.
        Choose how to handle each:
      </p>
      <div className="conflict-table">
        {conflicts.map((c) => (
          <div key={c.filename} className="conflict-row">
            <span className="conflict-filename" title={c.filename}>{c.filename}</span>
            <div className="conflict-meta">
              <span className="conflict-meta-col">
                <strong>Incoming:</strong> {formatSize(c.sourceSize)} {formatDate(c.sourceModifiedAt)}
              </span>
              <span className="conflict-meta-col">
                <strong>Existing:</strong> {formatSize(c.targetSize)} {formatDate(c.targetModifiedAt)}
              </span>
            </div>
            <div className="conflict-choices">
              {(['keep_source', 'keep_target', 'keep_both'] as const).map((opt) => (
                <label
                  key={opt}
                  className={`conflict-choice${resolutions[c.filename] === opt ? ' conflict-choice--active' : ''}`}
                >
                  <input
                    type="radio"
                    name={`conflict-${c.filename}`}
                    value={opt}
                    checked={resolutions[c.filename] === opt}
                    onChange={() => onSet(c.filename, opt)}
                  />
                  {opt === 'keep_source' ? 'Use incoming' : opt === 'keep_target' ? 'Keep existing' : 'Keep both'}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="conflict-panel-footer">
        <button
          type="button"
          className="modal-btn-primary"
          disabled={!allResolved || submitting}
          onClick={onSubmit}
        >
          {submitting ? 'Applying…' : 'Apply Resolutions'}
        </button>
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

interface Props {
  jobIds:  string[];
  onClose: () => void;
}

export function MergeProgressModal({ jobIds, onClose }: Props) {
  const [jobs, setJobs] = useState<JobState[]>(
    jobIds.map((id) => ({ jobId: id, status: 'pending' })),
  );
  const [resolutions, setResolutions] = useState<Record<string, Record<string, ConflictResolution>>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  const allDone       = jobs.every((j) => j.status === 'completed' || j.status === 'failed');
  // User must stay to resolve conflicts — navigating away would leave the merge permanently blocked
  const needsAttention = jobs.some((j) => j.status === 'awaiting_resolution');

  useEffect(() => {
    const poll = async () => {
      const updated = await Promise.all(
        jobIds.map(async (jobId) => {
          try {
            const res  = await fetch(`/api/merge-jobs/${jobId}`);
            const data = await res.json() as JobState & { jobId?: string };
            return { ...data, jobId };
          } catch {
            return { jobId, status: 'failed' as MergeJobStatus, errorMessage: 'Network error' };
          }
        }),
      );
      setJobs(updated);
    };

    void poll();
    if (allDone) return;
    const id = setInterval(() => void poll(), 2000);
    return () => clearInterval(id);
  }, [jobIds, allDone]);

  function setResolution(jobId: string, filename: string, value: ConflictResolution) {
    setResolutions((prev) => ({
      ...prev,
      [jobId]: { ...(prev[jobId] ?? {}), [filename]: value },
    }));
  }

  async function submitResolution(jobId: string) {
    setSubmitting(jobId);
    try {
      await fetch(`/api/merge-jobs/${jobId}/resolve`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ resolutions: resolutions[jobId] ?? {} }),
      });
    } finally {
      setSubmitting(null);
    }
  }

  // Dismissable unless there are unresolved conflicts (dismissing would strand the merge)
  const canDismiss = !needsAttention;

  return (
    <div className="modal-overlay" onClick={allDone ? onClose : undefined}>
      <div className="modal-box merge-progress-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Linking Assets</h2>
          {canDismiss && (
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        <div className="merge-job-list">
          {jobs.map((job) => (
            <div key={job.jobId} className={`merge-job-item merge-job-item--${job.status}`}>
              <div className="merge-job-header">
                <span className="merge-job-dot" />
                <span className="merge-job-label">{STATUS_LABEL[job.status]}</span>
                {job.status === 'failed' && job.errorMessage && (
                  <span className="merge-job-error">{job.errorMessage}</span>
                )}
              </div>

              {job.status === 'awaiting_resolution' && job.conflicts && (
                <ConflictResolutionPanel
                  conflicts={job.conflicts}
                  resolutions={resolutions[job.jobId] ?? {}}
                  onSet={(filename, value) => setResolution(job.jobId, filename, value)}
                  onSubmit={() => void submitResolution(job.jobId)}
                  submitting={submitting === job.jobId}
                />
              )}
            </div>
          ))}
        </div>

        {allDone && (
          <div className="modal-actions">
            <button type="button" className="modal-btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {!allDone && needsAttention && (
          <p className="merge-progress-note merge-progress-note--warn">
            Resolve all conflicts above to continue the merge.
          </p>
        )}

        {!allDone && !needsAttention && (
          <div className="modal-actions modal-actions--spaced">
            <p className="merge-progress-note">
              Merge is running in the background — project cards will update when done.
            </p>
            <button type="button" className="modal-btn-ghost" onClick={onClose}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
