'use client';

import { useState, useEffect }  from 'react';
import { useUploadQueue }        from '@/hooks/useUploadQueue';
import type { UploadJob, UploadJobProvider, UploadJobStatus } from '@/lib/services/upload-queue-service';

const ACTIVE:   Set<UploadJobStatus> = new Set(['queued', 'compressing', 'uploading']);
const TERMINAL: Set<UploadJobStatus> = new Set(['done', 'failed', 'cancelled']);

function phaseLabel(status: UploadJobStatus, progress: number): string {
  switch (status) {
    case 'queued':      return 'Queued';
    case 'compressing': return `Compressing… ${progress > 0 ? `${progress}%` : ''}`.trim();
    case 'uploading':   return `Uploading… ${progress > 0 ? `${progress}%` : ''}`.trim();
    case 'done':        return 'Done';
    case 'failed':      return 'Failed';
    case 'cancelled':   return 'Cancelled';
  }
}

function providerLabel(provider: UploadJobProvider): string {
  return provider === 'leaderpass' ? 'LeaderPass' : 'Frame.io';
}

const XIcon = () => (
  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

function JobRow({ job, onCancel }: { job: UploadJob; onCancel: () => void }) {
  const isActive = ACTIVE.has(job.status);
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
      {isActive && (
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
  const [open,    setOpen]    = useState(false);
  const [visible, setVisible] = useState(false);
  const [cleared, setCleared] = useState<Set<string>>(new Set());

  const jobs         = allJobs.filter((j) => !cleared.has(j.jobId));
  const activeJobs   = jobs.filter((j) => ACTIVE.has(j.status));
  const terminalJobs = jobs.filter((j) => TERMINAL.has(j.status));
  const failedJobs   = terminalJobs.filter((j) => j.status === 'failed');
  const displayJobs  = [...activeJobs, ...terminalJobs.slice(-4)];

  const hasFailures  = failedJobs.length > 0;
  const allDoneClean = jobs.length > 0 && activeJobs.length === 0 && !hasFailures;
  const currentJob   = activeJobs[0];

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
            <span className="tt-card-title">
              {activeJobs.length > 0 ? `${providerLabel(activeJobs[0].provider)} Publish` : 'Publish Queue'}
            </span>
            {activeJobs.length > 0 && (
              <span className="tt-badge">{activeJobs.length} active</span>
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
          <div className="tt-jobs">
            {displayJobs.map((job) => (
              <JobRow key={job.jobId} job={job} onCancel={() => cancel(job.jobId)} />
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
              {currentJob?.status === 'compressing'
                ? `Compressing ${currentJob.filename}…`
                : (currentJob ? `${currentJob.filename} → ${providerLabel(currentJob.provider)}` : 'Publishing…')}
            </span>
            {activeJobs.length > 1 && <span className="tt-pill-count">+{activeJobs.length - 1}</span>}
          </>
        ) : hasFailures ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span className="tt-pill-label">
              {failedJobs.length === 1 ? `Upload failed: ${failedJobs[0].filename}` : `${failedJobs.length} uploads failed`}
            </span>
          </>
        ) : (
          <>
            <CloudIcon />
            <span className="tt-pill-label">Upload complete</span>
          </>
        )}
      </button>
    </div>
  );
}
