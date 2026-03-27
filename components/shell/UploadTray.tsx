'use client';

import { useEffect, useMemo, useState } from 'react';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import type { UploadJob, UploadJobStatus } from '@/lib/services/upload-queue-service';

const ACTIVE: Set<UploadJobStatus> = new Set(['queued', 'compressing', 'uploading', 'processing']);
const RUNNING: Set<UploadJobStatus> = new Set(['compressing', 'uploading', 'processing']);
const TERMINAL: Set<UploadJobStatus> = new Set(['done', 'failed', 'cancelled']);
const STALLED_AFTER_MS = 2 * 60 * 1000;

function phaseLabel(status: UploadJobStatus, progress: number): string {
  switch (status) {
    case 'queued':      return 'Waiting to start';
    case 'compressing': return `Compressing${progress > 0 ? ` ${progress}%` : ''}`;
    case 'uploading':   return `Uploading${progress > 0 ? ` ${progress}%` : ''}`;
    case 'processing':  return 'Processing';
    case 'done':        return 'Done';
    case 'failed':      return 'Failed';
    case 'cancelled':   return 'Cancelled';
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

function describeJob(job: UploadJob, now: number): string | null {
  const updatedAgo = Math.max(0, now - Date.parse(job.updatedAt));
  const queuedAgo = Math.max(0, now - Date.parse(job.queuedAt));

  if (job.status === 'queued') {
    return `Queued ${formatElapsed(queuedAgo)} ago`;
  }

  if (job.status === 'processing') {
    return job.detail
      ? `${job.detail} - ${formatElapsed(updatedAgo)} so far`
      : `Processing for ${formatElapsed(updatedAgo)}`;
  }

  if (RUNNING.has(job.status)) {
    if (job.detail) {
      return `${job.detail} - updated ${formatElapsed(updatedAgo)} ago`;
    }
    if (updatedAgo >= STALLED_AFTER_MS) {
      return `No progress update for ${formatElapsed(updatedAgo)}`;
    }
    return `Updated ${formatElapsed(updatedAgo)} ago`;
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

function JobRow({ job, now, onCancel }: { job: UploadJob; now: number; onCancel: () => void }) {
  const isActive = ACTIVE.has(job.status);
  const detail = describeJob(job, now);

  return (
    <div className={`tt-job tt-job--${job.status}`}>
      <div className="tt-job-top">
        <div className="tt-job-info">
          <span className="tt-job-name" title={job.filename}>{job.filename}</span>
          <span className="tt-job-phase">{phaseLabel(job.status, job.progress)}</span>
        </div>
        {isActive && (
          <button
            type="button"
            className="tt-cancel-btn"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            aria-label={`Cancel upload of ${job.filename}`}
            title="Cancel"
          >
            <XIcon />
          </button>
        )}
      </div>
      {detail && <p className="tt-meta">{detail}</p>}
      {isActive && job.status !== 'queued' && (
        <div className="tt-progress">
          <div className="tt-progress-fill" style={{ width: `${job.progress}%` }} />
        </div>
      )}
      {job.status === 'failed' && job.error && (
        <p className="tt-error">{job.error}</p>
      )}
    </div>
  );
}

export function UploadTray() {
  const { jobs: allJobs, cancel } = useUploadQueue();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const jobs = useMemo(() => allJobs.filter((j) => !cleared.has(j.jobId)), [allJobs, cleared]);
  const waitingJobs = jobs.filter((j) => j.status === 'queued');
  const runningJobs = jobs.filter((j) => RUNNING.has(j.status));
  const activeJobs = jobs.filter((j) => ACTIVE.has(j.status));
  const terminalJobs = jobs.filter((j) => TERMINAL.has(j.status));
  const failedJobs = terminalJobs.filter((j) => j.status === 'failed');
  const displayJobs = [...runningJobs, ...waitingJobs, ...terminalJobs.slice(-4)];

  const hasFailures = failedJobs.length > 0;
  const allDoneClean = jobs.length > 0 && activeJobs.length === 0 && !hasFailures;
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

  const CloudIcon = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    </svg>
  );

  return (
    <div className="tt-tray">
      {open && (
        <div className="tt-card">
          <div className="tt-card-header">
            <span className="tt-card-title">Publish Status</span>
            {runningJobs.length > 0 && (
              <span className="tt-badge">{runningJobs.length} running</span>
            )}
            {waitingJobs.length > 0 && (
              <span className="tt-badge tt-badge--muted">{waitingJobs.length} waiting</span>
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
          <div className="tt-card-subtitle">Live job status. Publishes can run in parallel.</div>
          <div className="tt-jobs">
            {displayJobs.map((job) => (
              <JobRow key={job.jobId} job={job} now={now} onCancel={() => cancel(job.jobId)} />
            ))}
          </div>
        </div>
      )}

      <button
        className={`tt-pill${activeJobs.length > 0 ? ' tt-pill--active' : hasFailures ? ' tt-pill--error' : ''}`}
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {activeJobs.length > 0 ? (
          <>
            <span className="tt-spinner" aria-hidden="true" />
            <span className="tt-pill-label">
              {currentJob
                ? `${currentJob.filename} - ${phaseLabel(currentJob.status, currentJob.progress)}`
                : 'Publish active'}
            </span>
            {activeJobs.length > 1 && <span className="tt-pill-count">+{activeJobs.length - 1}</span>}
          </>
        ) : hasFailures ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="tt-pill-label">
              {failedJobs.length === 1 ? `Upload failed: ${failedJobs[0].filename}` : `${failedJobs.length} uploads failed`}
            </span>
          </>
        ) : (
          <>
            <CloudIcon />
            <span className="tt-pill-label">Uploads complete</span>
          </>
        )}
      </button>
    </div>
  );
}
