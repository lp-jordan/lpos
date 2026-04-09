'use client';

import { useEffect, useMemo, useState } from 'react';
import { useIngestQueue } from '@/hooks/useIngestQueue';
import type { IngestJob, IngestJobStatus } from '@/lib/services/ingest-queue-service';

const ACTIVE: Set<IngestJobStatus> = new Set(['queued', 'ingesting']);
const RUNNING: Set<IngestJobStatus> = new Set(['ingesting']);
const TERMINAL: Set<IngestJobStatus> = new Set(['done', 'failed', 'cancelled', 'awaiting_confirmation']);
const STALLED_AFTER_MS = 2 * 60 * 1000;

function formatBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function phaseLabel(status: IngestJobStatus, progress: number, resumable?: boolean): string {
  switch (status) {
    case 'queued':                return resumable ? `Paused at ${progress}%` : 'Waiting to start';
    case 'ingesting':             return progress > 0 ? `Ingesting ${progress}%` : 'Starting upload…';
    case 'done':                  return 'Done';
    case 'failed':                return 'Failed';
    case 'cancelled':             return 'Cancelled';
    case 'awaiting_confirmation': return 'Needs confirmation';
  }
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function describeJob(job: IngestJob, now: number): string | null {
  const updatedAgo = Math.max(0, now - Date.parse(job.updatedAt));
  const queuedAgo = Math.max(0, now - Date.parse(job.queuedAt));
  const sizeStr = job.fileSize ? ` · ${formatBytes(job.fileSize)}` : '';

  if (job.status === 'queued') {
    return `Queued ${formatElapsed(queuedAgo)} ago${sizeStr}`;
  }

  if (job.status === 'ingesting') {
    if (updatedAgo >= STALLED_AFTER_MS) {
      return `No progress update for ${formatElapsed(updatedAgo)}`;
    }
    if (job.detail) {
      return `${job.detail}${sizeStr}`;
    }
    return `Updated ${formatElapsed(updatedAgo)} ago${sizeStr}`;
  }

  if (job.completedAt) {
    const completedAgo = Math.max(0, now - Date.parse(job.completedAt));
    return `Finished ${formatElapsed(completedAgo)} ago`;
  }

  return null;
}

const XIcon = () => (
  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function JobRow({
  job, now, onCancel, onConfirmVersion, onDeclineVersion, confirming,
}: {
  job: IngestJob;
  now: number;
  onCancel: () => void;
  onConfirmVersion: (job: IngestJob) => void;
  onDeclineVersion: (job: IngestJob) => void;
  confirming?: boolean;
}) {
  const isActive   = ACTIVE.has(job.status);
  const isTerminal = TERMINAL.has(job.status);
  const [collapsed, setCollapsed] = useState(isTerminal);
  const detail = describeJob(job, now);

  // A queued job with a tempPath and partial progress is a resumable chunked upload.
  const isResumable = job.status === 'queued' && !!job.tempPath && (job.progress ?? 0) > 0;

  return (
    <div className={`tt-job tt-job--${job.status}${isResumable ? ' tt-job--resumable' : ''}`}>
      <div
        className="tt-job-top"
        onClick={isTerminal ? () => setCollapsed((v) => !v) : undefined}
        style={isTerminal ? { cursor: 'pointer' } : undefined}
      >
        <div className="tt-job-info">
          {isTerminal && <span className="tt-job-toggle">{collapsed ? '▸' : '▾'}</span>}
          <span className="tt-job-name" title={job.filename}>{job.filename}</span>
          <span className="tt-job-phase">{phaseLabel(job.status, job.progress, isResumable)}</span>
        </div>
        {isActive && (
          <button
            type="button"
            className="tt-cancel-btn"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            aria-label={`Cancel ingest of ${job.filename}`}
            title="Cancel"
          >
            <XIcon />
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          {detail && <p className="tt-meta">{detail}</p>}
          {isActive && job.status !== 'queued' && (
            <div className="tt-progress">
              <div className="tt-progress-fill" style={{ width: `${job.progress}%` }} />
            </div>
          )}
          {job.status === 'failed' && job.error && (
            <p className="tt-error">{job.error}</p>
          )}
          {isResumable && (
            <p className="tt-warning">Re-drop <strong>{job.filename}</strong> to the media tab to resume from {job.progress}%.</p>
          )}
          {job.status === 'awaiting_confirmation' && (
            <div className="tt-confirmation">
              <p className="tt-warning">New version detected for <strong>{job.filename}</strong>.</p>
              <div className="tt-confirmation-actions">
                <button
                  type="button"
                  className="tt-action-btn tt-action-btn--primary"
                  disabled={confirming}
                  onClick={(e) => { e.stopPropagation(); onConfirmVersion(job); }}
                >
                  {confirming ? 'Confirming…' : 'Confirm version'}
                </button>
                <button
                  type="button"
                  className="tt-action-btn"
                  disabled={confirming}
                  onClick={(e) => { e.stopPropagation(); onDeclineVersion(job); }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function IngestTray() {
  const { jobs: allJobs, cancel } = useIngestQueue();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(new Set());

  async function handleConfirmVersion(job: IngestJob) {
    if (!job.uploadId || !job.versionMeta?.existingAsset) return;
    const { assetId } = job.versionMeta.existingAsset as { assetId: string };
    setConfirmingIds((prev) => new Set([...prev, job.jobId]));
    try {
      await fetch(`/api/projects/${job.projectId}/media/upload/${job.uploadId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replaceAssetId: assetId }),
      });
    } finally {
      setConfirmingIds((prev) => { const next = new Set(prev); next.delete(job.jobId); return next; });
    }
  }

  async function handleDeclineVersion(job: IngestJob) {
    if (!job.uploadId) return;
    await fetch(`/api/projects/${job.projectId}/media/upload/${job.uploadId}`, { method: 'DELETE' });
  }

  const jobs = useMemo(() => allJobs.filter((j) => !cleared.has(j.jobId)), [allJobs, cleared]);
  const waitingJobs = jobs.filter((j) => j.status === 'queued');
  const runningJobs = jobs.filter((j) => RUNNING.has(j.status));
  const activeJobs = jobs.filter((j) => ACTIVE.has(j.status));
  const terminalJobs = jobs.filter((j) => TERMINAL.has(j.status));
  const failedJobs = terminalJobs.filter((j) => j.status === 'failed');
  const confirmationJobs = terminalJobs.filter((j) => j.status === 'awaiting_confirmation');
  const displayJobs = [...runningJobs, ...waitingJobs, ...terminalJobs.slice(-4)];

  const hasFailures = failedJobs.length > 0;
  const hasPendingConfirmations = confirmationJobs.length > 0;
  const allDoneClean = jobs.length > 0 && activeJobs.length === 0 && !hasFailures && !hasPendingConfirmations;
  const currentJob = runningJobs[0] ?? waitingJobs[0];

  function clearTerminal() {
    setCleared((prev) => {
      const next = new Set(prev);
      terminalJobs.forEach((j) => next.add(j.jobId));
      return next;
    });
  }

  useEffect(() => { if (jobs.length > 0) setVisible(true); }, [jobs.length]);
  useEffect(() => { if (activeJobs.length > 0) setOpen(true); }, [activeJobs.length]);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!allDoneClean) return;
    const t = setTimeout(() => { setVisible(false); setOpen(false); }, 6000);
    return () => clearTimeout(t);
  }, [allDoneClean]);

  useEffect(() => {
    if (visible && jobs.length === 0) { setVisible(false); setOpen(false); }
  }, [visible, jobs.length]);

  if (!visible || displayJobs.length === 0) return null;

  const InboxIcon = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <polyline points="8 17 12 21 16 17" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />
    </svg>
  );

  return (
    <div className="tt-tray">
      {open && (
        <div className="tt-card">
          <div className="tt-card-header">
            <span className="tt-card-title">Ingest Status</span>
            {runningJobs.length > 0 && (
              <span className="tt-badge">{runningJobs.length} running</span>
            )}
            {waitingJobs.length > 0 && (
              <span className="tt-badge tt-badge--muted">{waitingJobs.length} waiting</span>
            )}
            {hasPendingConfirmations && (
              <span className="tt-badge tt-badge--warning">{confirmationJobs.length} need confirmation</span>
            )}
            {hasFailures && (
              <span className="tt-badge tt-badge--error">{failedJobs.length} failed</span>
            )}
            {terminalJobs.length > 0 && activeJobs.length === 0 && (
              <button className="tt-clear-btn" type="button" onClick={clearTerminal}>Clear</button>
            )}
            <button className="tt-close" type="button" onClick={() => setOpen(false)} aria-label="Close">
              <XIcon />
            </button>
          </div>
          <div className="tt-card-subtitle">Live job status. Shows running, waiting, and recent results.</div>
          <div className="tt-jobs">
            {displayJobs.map((job) => (
              <JobRow
                key={job.jobId}
                job={job}
                now={now}
                onCancel={() => cancel(job.jobId)}
                onConfirmVersion={handleConfirmVersion}
                onDeclineVersion={handleDeclineVersion}
                confirming={confirmingIds.has(job.jobId)}
              />
            ))}
          </div>
        </div>
      )}

      <button
        className={`tt-pill${activeJobs.length > 0 ? ' tt-pill--active' : hasFailures ? ' tt-pill--error' : hasPendingConfirmations ? ' tt-pill--warning' : ''}`}
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {activeJobs.length > 0 ? (
          <>
            <span className="tt-spinner" aria-hidden="true" />
            <span className="tt-pill-label">
              {currentJob ? `${currentJob.filename} - ${phaseLabel(currentJob.status, currentJob.progress)}` : 'Ingest active'}
            </span>
            {activeJobs.length > 1 && <span className="tt-pill-count">+{activeJobs.length - 1}</span>}
          </>
        ) : hasFailures ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="tt-pill-label">
              {failedJobs.length === 1 ? `Ingest failed: ${failedJobs[0].filename}` : `${failedJobs.length} ingests failed`}
            </span>
          </>
        ) : hasPendingConfirmations ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="tt-pill-label">
              {confirmationJobs.length === 1
                ? `Confirm version: ${confirmationJobs[0].filename}`
                : `${confirmationJobs.length} files need confirmation`}
            </span>
          </>
        ) : (
          <>
            <InboxIcon />
            <span className="tt-pill-label">Ingest complete</span>
          </>
        )}
      </button>
    </div>
  );
}
