'use client';

import { useState, useEffect } from 'react';
import { useTranscriptQueue } from '@/hooks/useTranscriptQueue';
import type { TranscriptJob, TranscriptJobStatus } from '@/lib/services/transcripter-service';

const ACTIVE: Set<TranscriptJobStatus> = new Set([
  'queued', 'extracting_audio', 'transcribing', 'writing_outputs',
]);
const TERMINAL: Set<TranscriptJobStatus> = new Set(['done', 'failed', 'canceled']);

function phaseLabel(status: TranscriptJobStatus): string {
  switch (status) {
    case 'queued':           return 'Queued';
    case 'extracting_audio': return 'Extracting audio…';
    case 'transcribing':     return 'Transcribing…';
    case 'writing_outputs':  return 'Writing outputs…';
    case 'done':             return 'Done';
    case 'failed':           return 'Failed';
    case 'canceled':         return 'Canceled';
  }
}

function JobRow({ job }: { job: TranscriptJob }) {
  const isActive = ACTIVE.has(job.status);
  return (
    <div className={`tt-job tt-job--${job.status}`}>
      <div className="tt-job-info">
        <span className="tt-job-name" title={job.filename}>{job.filename}</span>
        <span className="tt-job-phase">{phaseLabel(job.status)}</span>
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

export function TranscriptTray() {
  const allJobs  = useTranscriptQueue();
  const [open,    setOpen]    = useState(false);
  const [visible, setVisible] = useState(false);
  // IDs of terminal jobs the user has manually cleared
  const [cleared, setCleared] = useState<Set<string>>(new Set());

  const jobs         = allJobs.filter((j) => !cleared.has(j.jobId));
  const activeJobs   = jobs.filter((j) => ACTIVE.has(j.status));
  const terminalJobs = jobs.filter((j) => TERMINAL.has(j.status));
  const failedJobs   = terminalJobs.filter((j) => j.status === 'failed');
  const displayJobs  = [...activeJobs, ...terminalJobs.slice(-4)];

  const hasFailures  = failedJobs.length > 0;
  // Auto-hide only when all jobs finished cleanly (no failures)
  const allDoneClean = jobs.length > 0 && activeJobs.length === 0 && !hasFailures;
  const currentJob   = activeJobs[0];

  function clearTerminal() {
    setCleared((prev) => {
      const next = new Set(prev);
      terminalJobs.forEach((j) => next.add(j.jobId));
      return next;
    });
  }

  // Show tray when any job arrives
  useEffect(() => {
    if (jobs.length > 0) setVisible(true);
  }, [jobs.length]);

  // Auto-open card when a job becomes active
  useEffect(() => {
    if (activeJobs.length > 0) setOpen(true);
  }, [activeJobs.length]);

  // Auto-hide 6s after all complete cleanly — never auto-hide on failures
  useEffect(() => {
    if (!allDoneClean) return;
    const t = setTimeout(() => { setVisible(false); setOpen(false); }, 6000);
    return () => clearTimeout(t);
  }, [allDoneClean]);

  // Hide when all jobs manually cleared
  useEffect(() => {
    if (visible && jobs.length === 0) { setVisible(false); setOpen(false); }
  }, [visible, jobs.length]);

  if (!visible || displayJobs.length === 0) return null;

  return (
    <div className="tt-tray">
      {open && (
        <div className="tt-card">
          <div className="tt-card-header">
            <span className="tt-card-title">Transcription</span>
            {activeJobs.length > 0 && (
              <span className="tt-badge">{activeJobs.length} active</span>
            )}
            {hasFailures && (
              <span className="tt-badge tt-badge--error">{failedJobs.length} failed</span>
            )}
            {terminalJobs.length > 0 && activeJobs.length === 0 && (
              <button className="tt-clear-btn" type="button" onClick={clearTerminal}>
                Clear
              </button>
            )}
            <button className="tt-close" type="button" onClick={() => setOpen(false)} aria-label="Close">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="tt-jobs">
            {displayJobs.map((job) => <JobRow key={job.jobId} job={job} />)}
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
            <span className="tt-pill-label">{currentJob?.filename ?? 'Transcribing…'}</span>
            {activeJobs.length > 1 && (
              <span className="tt-pill-count">+{activeJobs.length - 1}</span>
            )}
          </>
        ) : hasFailures ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span className="tt-pill-label">
              {failedJobs.length === 1 ? `Failed: ${failedJobs[0].filename}` : `${failedJobs.length} jobs failed`}
            </span>
          </>
        ) : (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="tt-pill-label">Transcription complete</span>
          </>
        )}
      </button>
    </div>
  );
}
