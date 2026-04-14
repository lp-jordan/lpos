'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';
import { usePipelineQueue } from '@/hooks/usePipelineQueue';
import type { PipelineEntry, PipelineStage, PipelineStageType } from '@/lib/types/pipeline';
import {
  formatElapsed,
  stageLabel,
  phaseLabel,
  overallLabel,
  overallBadgeClass,
  isActive,
  hasFailed,
  stageRemainingMs,
  RETRYABLE_STAGES,
  STAGE_TERMINAL_STATUSES,
  PIPELINE_TERMINAL_STATUSES,
} from '@/lib/pipeline-helpers';

type StatusFilter = 'all' | 'active' | 'queued' | 'failed' | 'completed';

// ── Previous jobs ─────────────────────────────────────────────────────────────

interface HistoryJob {
  filename:    string;
  queuedAt:    string;
  completedAt: string;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return '<1s';
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function formatUploadedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function PreviousJobsModal({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs]     = useState<HistoryJob[] | null>(null);
  const [error, setError]   = useState(false);

  useEffect(() => {
    fetch('/api/jobs/history')
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => setError(true));
  }, []);

  // Close on backdrop click
  const onBackdrop = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="pjobs-backdrop" onClick={onBackdrop}>
      <div className="pjobs-modal" role="dialog" aria-modal="true" aria-label="Previous jobs">
        <div className="pjobs-header">
          <span className="pjobs-title">Previous jobs</span>
          <button type="button" className="pjobs-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="pjobs-body">
          {error && <p className="pjobs-message">Failed to load history.</p>}
          {!error && jobs === null && <p className="pjobs-message">Loading…</p>}
          {!error && jobs !== null && jobs.length === 0 && (
            <p className="pjobs-message">No completed uploads in the last 7 days.</p>
          )}
          {!error && jobs !== null && jobs.length > 0 && (
            <table className="pjobs-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Uploaded</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => {
                  const duration = Date.parse(job.completedAt) - Date.parse(job.queuedAt);
                  return (
                    <tr key={i}>
                      <td className="pjobs-filename" title={job.filename}>{job.filename}</td>
                      <td className="pjobs-when">{formatUploadedAt(job.queuedAt)}</td>
                      <td className="pjobs-duration">{formatDuration(duration)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stage row ────────────────────────────────────────────────────────────────

function QueueStage({
  stage,
  now,
  onRetry,
  onCancel,
}: {
  stage: PipelineStage;
  now: number;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const terminal = STAGE_TERMINAL_STATUSES.has(stage.status);
  const active = !terminal;
  const elapsed = Math.max(0, now - Date.parse(stage.updatedAt));

  return (
    <div className={`queue-stage queue-stage--${stage.status}`}>
      <span className="queue-stage-label">{stageLabel(stage.type)}</span>
      <span className="queue-stage-phase">{phaseLabel(stage)}</span>
      {active && stage.progress > 0 && (
        <div className="queue-stage-bar">
          <div className="queue-stage-bar-fill" style={{ width: `${stage.progress}%` }} />
        </div>
      )}
      {stage.stalled && (
        <span className="queue-stage-stall">Stalled {formatElapsed(elapsed)}</span>
      )}
      {stage.error && <span className="queue-stage-error" title={stage.error}>{stage.error}</span>}
      {stage.status === 'failed' && RETRYABLE_STAGES.has(stage.type) && (
        <button type="button" className="queue-action-btn queue-action-btn--retry" onClick={onRetry}>Retry</button>
      )}
      {active && (
        <button type="button" className="queue-action-btn queue-action-btn--cancel" onClick={onCancel}>Cancel</button>
      )}
    </div>
  );
}

// ── Entry row ────────────────────────────────────────────────────────────────

function QueueEntry({
  entry,
  now,
  onRetry,
  onCancel,
}: {
  entry: PipelineEntry;
  now: number;
  onRetry: (st: PipelineStageType) => void;
  onCancel: (st: PipelineStageType) => void;
}) {
  const terminal = PIPELINE_TERMINAL_STATUSES.has(entry.overallStatus);
  const [collapsed, setCollapsed] = useState(terminal);
  const elapsed = Math.max(0, now - Date.parse(entry.createdAt));

  return (
    <div className="queue-entry">
      <div
        className="queue-entry-header"
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') setCollapsed((v) => !v); }}
      >
        <span className="queue-entry-toggle">{collapsed ? '▸' : '▾'}</span>
        <span className="queue-entry-name" title={entry.filename}>{entry.filename}</span>
        <span className={`queue-entry-badge ${overallBadgeClass(entry.overallStatus)}`}>
          {overallLabel(entry.overallStatus)}
        </span>
        <span className="queue-entry-elapsed">{formatElapsed(elapsed)}</span>
      </div>
      {!collapsed && (
        <div className="queue-entry-stages">
          {entry.stages.map((stage) => (
            <QueueStage
              key={stage.jobId}
              stage={stage}
              now={now}
              onRetry={() => onRetry(stage.type)}
              onCancel={() => onCancel(stage.type)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Project group ────────────────────────────────────────────────────────────

function ProjectGroup({
  projectName,
  entries,
  now,
  onRetry,
  onCancel,
}: {
  projectName: string;
  entries: PipelineEntry[];
  now: number;
  onRetry: (pipelineId: string, st: PipelineStageType) => void;
  onCancel: (pipelineId: string, st: PipelineStageType) => void;
}) {
  const allComplete = entries.every((e) => PIPELINE_TERMINAL_STATUSES.has(e.overallStatus));
  const [collapsed, setCollapsed] = useState(allComplete);
  const activeCount = entries.filter(isActive).length;
  const failedCount = entries.filter(hasFailed).length;

  return (
    <div className="queue-project-group">
      <div
        className="queue-project-header"
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') setCollapsed((v) => !v); }}
      >
        <span className="queue-project-toggle">{collapsed ? '▸' : '▾'}</span>
        <span className="queue-project-name">{projectName}</span>
        <span className="queue-project-count">{entries.length} item{entries.length !== 1 ? 's' : ''}</span>
        {activeCount > 0 && <span className="queue-project-badge queue-project-badge--active">{activeCount} active</span>}
        {failedCount > 0 && <span className="queue-project-badge queue-project-badge--failed">{failedCount} failed</span>}
      </div>
      {!collapsed && (
        <div className="queue-project-entries">
          {entries.map((entry) => (
            <QueueEntry
              key={entry.pipelineId}
              entry={entry}
              now={now}
              onRetry={(st) => onRetry(entry.pipelineId, st)}
              onCancel={(st) => onCancel(entry.pipelineId, st)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function QueueView() {
  const { pipelines, retry, cancel, clearFailed, clearCancelled } = usePipelineQueue();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [now, setNow] = useState(() => Date.now());
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // Unique projects
  const projects = useMemo(() => {
    const map = new Map<string, string>();
    pipelines.forEach((p) => map.set(p.projectId, p.projectName));
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
  }, [pipelines]);

  // Filter
  const filtered = useMemo(() => {
    let result = pipelines;
    if (projectFilter !== 'all') {
      result = result.filter((p) => p.projectId === projectFilter);
    }
    switch (statusFilter) {
      case 'active':
        result = result.filter(isActive);
        break;
      case 'queued':
        result = result.filter((p) => isActive(p) && p.stages.some((s) => s.status === 'queued'));
        break;
      case 'failed':
        result = result.filter(hasFailed);
        break;
      case 'completed':
        result = result.filter((p) => p.overallStatus === 'complete' || p.overallStatus === 'cancelled');
        break;
    }
    return result;
  }, [pipelines, statusFilter, projectFilter]);

  // Group by project
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; entries: PipelineEntry[] }>();
    for (const entry of filtered) {
      const existing = map.get(entry.projectId);
      if (existing) {
        existing.entries.push(entry);
      } else {
        map.set(entry.projectId, { name: entry.projectName, entries: [entry] });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [filtered]);

  // Summary counts
  const totalActive    = pipelines.filter(isActive).length;
  const totalQueued    = pipelines.filter((p) => isActive(p) && p.stages.some((s) => s.status === 'queued')).length;
  const totalFailed    = pipelines.filter(hasFailed).length;
  const totalCancelled = pipelines.filter((p) => p.overallStatus === 'cancelled').length;

  // Aggregate ETA across all active stages with measurable progress
  const totalRemainingMs = useMemo(() => {
    let sum = 0;
    let hasAny = false;
    for (const entry of pipelines) {
      if (!isActive(entry)) continue;
      for (const stage of entry.stages) {
        const r = stageRemainingMs(stage, now);
        if (r !== null) { sum += r; hasAny = true; }
      }
    }
    return hasAny ? sum : null;
  }, [pipelines, now]);

  return (
    <div className="queue-view">
      <div className="queue-header">
        <h1 className="queue-title">Pipeline Queue</h1>
        <div className="queue-summary">
          {totalActive > 0 && <span className="queue-summary-badge queue-summary-badge--active">{totalActive} active</span>}
          {totalQueued > 0 && <span className="queue-summary-badge queue-summary-badge--queued">{totalQueued} queued</span>}
          {totalFailed > 0 && <span className="queue-summary-badge queue-summary-badge--failed">{totalFailed} failed</span>}
          {pipelines.length === 0 && <span className="queue-summary-badge">No entries</span>}
          {totalRemainingMs !== null && (
            <span className="queue-summary-remaining">~{formatElapsed(totalRemainingMs)} remaining</span>
          )}
          {totalFailed > 0 && (
            <button
              type="button"
              className="queue-clear-btn queue-clear-btn--danger"
              onClick={clearFailed}
            >
              Clear {totalFailed} failed
            </button>
          )}
          {totalCancelled > 0 && (
            <button
              type="button"
              className="queue-clear-btn"
              onClick={clearCancelled}
            >
              Clear {totalCancelled} cancelled
            </button>
          )}
        </div>
      </div>

      <div className="queue-filters">
        <select
          className="queue-filter-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="queued">Queued</option>
          <option value="failed">Failed</option>
          <option value="completed">Completed</option>
        </select>
        <select
          className="queue-filter-select"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
        >
          <option value="all">All projects</option>
          {projects.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </div>

      {grouped.length === 0 ? (
        <div className="queue-empty">
          <p>No pipeline entries{statusFilter !== 'all' || projectFilter !== 'all' ? ' match your filters' : ''}.</p>
        </div>
      ) : (
        <div className="queue-groups">
          {grouped.map((group) => (
            <ProjectGroup
              key={group.name}
              projectName={group.name}
              entries={group.entries}
              now={now}
              onRetry={retry}
              onCancel={cancel}
            />
          ))}
        </div>
      )}

      <div className="queue-history-trigger">
        <button type="button" className="queue-history-btn" onClick={() => setShowHistory(true)}>
          Previous jobs
        </button>
      </div>

      {showHistory && <PreviousJobsModal onClose={() => setShowHistory(false)} />}
    </div>
  );
}
