'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePipelineQueue } from '@/hooks/usePipelineQueue';
import type { PipelineEntry, PipelineStage, PipelineStageType } from '@/lib/types/pipeline';
import {
  formatElapsed,
  stageLabel,
  phaseLabel,
  overallLabel,
  overallBadgeClass,
  isActive,
  isWaiting,
  hasFailed,
  RETRYABLE_STAGES,
  PIPELINE_TERMINAL_STATUSES,
  STAGE_TERMINAL_STATUSES,
} from '@/lib/pipeline-helpers';

// ── Icons ────────────────────────────────────────────────────────────────────

const XIcon = () => (
  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const RetryIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const PipelineIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
  </svg>
);

// ── Stage row ────────────────────────────────────────────────────────────────

function StageRow({
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
    <div className={`tt-stage tt-stage--${stage.status}`}>
      <div className="tt-stage-top">
        <span className="tt-stage-label">{stageLabel(stage.type)}</span>
        <span className="tt-stage-phase">{phaseLabel(stage)}</span>
        {stage.stalled && (
          <span className="tt-stall-warning">Stalled {formatElapsed(elapsed)}</span>
        )}
        {stage.status === 'failed' && RETRYABLE_STAGES.has(stage.type) && (
          <button type="button" className="tt-retry-btn" onClick={(e) => { e.stopPropagation(); onRetry(); }}>
            <RetryIcon /> Retry
          </button>
        )}
        {active && (
          <button
            type="button"
            className="tt-cancel-btn"
            style={{ opacity: 1 }}
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            title="Cancel"
          >
            <XIcon />
          </button>
        )}
      </div>
      {active && stage.status !== 'queued' && stage.progress > 0 && (
        <div className="tt-progress">
          <div className="tt-progress-fill" style={{ width: `${stage.progress}%` }} />
        </div>
      )}
      {stage.error && <p className="tt-error">{stage.error}</p>}
    </div>
  );
}

// ── Pipeline row ─────────────────────────────────────────────────────────────

function PipelineRow({
  entry,
  now,
  onRetry,
  onCancel,
}: {
  entry: PipelineEntry;
  now: number;
  onRetry: (stageType: PipelineStageType) => void;
  onCancel: (stageType: PipelineStageType) => void;
}) {
  return (
    <div className="tt-pipeline-row">
      <div className="tt-pipeline-header">
        <span className="tt-pipeline-name" title={entry.filename}>{entry.filename}</span>
        <span className="tt-project-name" title={entry.projectName}>{entry.projectName}</span>
        <span className={`tt-overall-badge ${overallBadgeClass(entry.overallStatus)}`}>
          {overallLabel(entry.overallStatus)}
        </span>
      </div>
      <div className="tt-stages">
        {entry.stages.map((stage) => (
          <StageRow
            key={stage.jobId}
            stage={stage}
            now={now}
            onRetry={() => onRetry(stage.type)}
            onCancel={() => onCancel(stage.type)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function PipelineTray() {
  const { pipelines: allPipelines, retry, cancel } = usePipelineQueue();
  const [open, setOpen] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [waitingExpanded, setWaitingExpanded] = useState(false);

  const pipelines = useMemo(() => allPipelines.filter((p) => !cleared.has(p.pipelineId)), [allPipelines, cleared]);

  const waitingPipelines = pipelines.filter((p) => isActive(p) && isWaiting(p));
  const collapseWaiting = waitingPipelines.length >= 4;
  const activePipelines = collapseWaiting
    ? pipelines.filter((p) => isActive(p) && !isWaiting(p))
    : pipelines.filter((p) => isActive(p));
  const queuedPipelines = collapseWaiting ? waitingPipelines : [];
  const terminalPipelines = pipelines.filter((p) => PIPELINE_TERMINAL_STATUSES.has(p.overallStatus));
  const failedPipelines = terminalPipelines.filter((p) => hasFailed(p));
  const completedPipelines = terminalPipelines.filter((p) => p.overallStatus === 'complete' || p.overallStatus === 'cancelled');

  const allActive = pipelines.filter((p) => isActive(p));
  const hasFailures = failedPipelines.length > 0;
  const allDoneClean = pipelines.length > 0 && allActive.length === 0 && !hasFailures;

  // Count of entries with at least one queued stage
  const queuedCount = pipelines.filter((p) =>
    p.stages.some((s) => s.status === 'queued') && isActive(p),
  ).length;

  const displayPipelines = [...activePipelines, ...failedPipelines, ...completedPipelines.slice(-8)];
  const isEmpty = displayPipelines.length === 0 && queuedPipelines.length === 0;

  function clearTerminal() {
    setCleared((prev) => {
      const next = new Set(prev);
      terminalPipelines.forEach((p) => next.add(p.pipelineId));
      return next;
    });
  }

  // Auto-open card when active jobs appear
  useEffect(() => { if (allActive.length > 0) setOpen(true); }, [allActive.length]);

  // Refresh timing every 8s
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 8_000);
    return () => window.clearInterval(timer);
  }, []);

  // Close card on outside click
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (trayRef.current && !trayRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Auto-close card after clean completion (pill stays visible)
  useEffect(() => {
    if (!allDoneClean) return;
    const t = setTimeout(() => setOpen(false), 6000);
    return () => clearTimeout(t);
  }, [allDoneClean]);

  // Pill summary
  const currentActive = activePipelines[0];
  const currentStage = currentActive?.stages.find((s) => !STAGE_TERMINAL_STATUSES.has(s.status));

  function pillLabel(): string {
    if (allActive.length > 0) {
      if (currentActive && currentStage) {
        return `${currentActive.filename} — ${stageLabel(currentStage.type)} ${phaseLabel(currentStage)}`;
      }
      return `${allActive.length} asset${allActive.length !== 1 ? 's' : ''} processing`;
    }
    if (hasFailures) {
      return failedPipelines.length === 1
        ? `Failed: ${failedPipelines[0].filename}`
        : `${failedPipelines.length} pipelines failed`;
    }
    if (queuedCount > 0) {
      return `${queuedCount} queued`;
    }
    if (completedPipelines.length > 0) {
      return 'Pipeline complete';
    }
    return 'Pipeline';
  }

  const isIdle = allActive.length === 0 && !hasFailures && queuedCount === 0 && completedPipelines.length === 0;

  return (
    <div className="tt-tray" ref={trayRef}>
      {open && (
        <div className="tt-card" style={{ minWidth: 340, maxWidth: 420 }}>
          <div className="tt-card-header">
            <span className="tt-card-title">Pipeline</span>
            {allActive.length > 0 && (
              <span className="tt-badge">{allActive.length} active</span>
            )}
            {hasFailures && (
              <span className="tt-badge tt-badge--error">{failedPipelines.length} failed</span>
            )}
            <Link href="/queue" className="tt-queue-link">View queue</Link>
            {terminalPipelines.length > 0 && allActive.length === 0 && (
              <button className="tt-clear-btn" type="button" onClick={clearTerminal}>Clear</button>
            )}
            <button className="tt-close" type="button" onClick={() => setOpen(false)} aria-label="Close">
              <XIcon />
            </button>
          </div>

          {isEmpty ? (
            <div className="tt-empty">
              <p>No active pipelines</p>
              <Link href="/queue" className="tt-queue-link">View full queue &rarr;</Link>
            </div>
          ) : (
            <div className="tt-jobs">
              {activePipelines.map((p) => (
                <PipelineRow
                  key={p.pipelineId}
                  entry={p}
                  now={now}
                  onRetry={(st) => retry(p.pipelineId, st)}
                  onCancel={(st) => cancel(p.pipelineId, st)}
                />
              ))}

              {queuedPipelines.length > 0 && (
                <>
                  <div
                    className="tt-waiting-summary"
                    onClick={() => setWaitingExpanded((v) => !v)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setWaitingExpanded((v) => !v); }}
                  >
                    <span>{queuedPipelines.length} asset{queuedPipelines.length !== 1 ? 's' : ''} ingesting…</span>
                    <span className="tt-waiting-expand">{waitingExpanded ? '▾ collapse' : '▸ expand'}</span>
                  </div>
                  {waitingExpanded && queuedPipelines.map((p) => (
                    <PipelineRow
                      key={p.pipelineId}
                      entry={p}
                      now={now}
                      onRetry={(st) => retry(p.pipelineId, st)}
                      onCancel={(st) => cancel(p.pipelineId, st)}
                    />
                  ))}
                </>
              )}

              {failedPipelines.map((p) => (
                <PipelineRow
                  key={p.pipelineId}
                  entry={p}
                  now={now}
                  onRetry={(st) => retry(p.pipelineId, st)}
                  onCancel={(st) => cancel(p.pipelineId, st)}
                />
              ))}

              {completedPipelines.slice(-8).map((p) => (
                <PipelineRow
                  key={p.pipelineId}
                  entry={p}
                  now={now}
                  onRetry={(st) => retry(p.pipelineId, st)}
                  onCancel={(st) => cancel(p.pipelineId, st)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <button
        className={`tt-pill${allActive.length > 0 ? ' tt-pill--active' : hasFailures ? ' tt-pill--error' : isIdle ? ' tt-pill--idle' : ''}`}
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {allActive.length > 0 ? (
          <>
            <span className="tt-spinner" aria-hidden="true" />
            <span className="tt-pill-label">{pillLabel()}</span>
            {allActive.length > 1 && <span className="tt-pill-count">+{allActive.length - 1}</span>}
          </>
        ) : hasFailures ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="tt-pill-label">{pillLabel()}</span>
          </>
        ) : (
          <>
            <PipelineIcon />
            <span className="tt-pill-label">{pillLabel()}</span>
            {queuedCount > 0 && <span className="tt-pill-count">{queuedCount}</span>}
          </>
        )}
      </button>
    </div>
  );
}
