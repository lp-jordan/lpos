import type { PipelineEntry, PipelineStage, PipelineStageType } from '@/lib/types/pipeline';
import { PIPELINE_TERMINAL_STATUSES, STAGE_TERMINAL_STATUSES } from '@/lib/types/pipeline';

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export function stageLabel(type: PipelineStageType): string {
  switch (type) {
    case 'ingest':           return 'Ingest';
    case 'transcript':       return 'Transcript';
    case 'upload:frameio':   return 'Frame.io';
    case 'upload:leaderpass': return 'LeaderPass';
  }
}

export function phaseLabel(stage: PipelineStage): string {
  const { type, status, progress } = stage;
  switch (type) {
    case 'ingest':
      if (status === 'queued')    return 'Waiting';
      if (status === 'ingesting') return progress > 0 ? `Ingesting ${progress}%` : 'Ingesting';
      if (status === 'done')      return 'Done';
      if (status === 'failed')    return 'Failed';
      if (status === 'cancelled') return 'Cancelled';
      return status;
    case 'transcript':
      if (status === 'queued')           return 'Queued';
      if (status === 'extracting_audio') return 'Extracting audio';
      if (status === 'transcribing')     return 'Transcribing';
      if (status === 'writing_outputs')  return 'Writing';
      if (status === 'done')             return 'Done';
      if (status === 'failed')           return 'Failed';
      if (status === 'canceled')         return 'Cancelled';
      return status;
    case 'upload:frameio':
      if (status === 'queued')      return 'Queued';
      if (status === 'compressing') return progress > 0 ? `Compressing ${progress}%` : 'Compressing';
      if (status === 'uploading')   return progress > 0 ? `Uploading ${progress}%` : 'Uploading';
      if (status === 'done')        return 'Done';
      if (status === 'failed')      return 'Failed';
      if (status === 'cancelled')   return 'Cancelled';
      return status;
    case 'upload:leaderpass':
      if (status === 'queued')      return 'Queued';
      if (status === 'uploading')   return progress > 0 ? `Uploading ${progress}%` : 'Uploading';
      if (status === 'processing')  return 'Processing';
      if (status === 'done')        return 'Ready';
      if (status === 'failed')      return 'Failed';
      if (status === 'cancelled')   return 'Cancelled';
      return status;
  }
}

export function overallLabel(status: PipelineEntry['overallStatus']): string {
  switch (status) {
    case 'ingesting':           return 'Ingesting';
    case 'transcribing':        return 'Transcribing';
    case 'uploading_frameio':   return 'Uploading';
    case 'uploading_leaderpass': return 'Publishing';
    case 'processing':          return 'Processing';
    case 'complete':            return 'Complete';
    case 'partial_failure':     return 'Partial Failure';
    case 'failed':              return 'Failed';
    case 'cancelled':           return 'Cancelled';
  }
}

export function overallBadgeClass(status: PipelineEntry['overallStatus']): string {
  if (status === 'complete') return 'tt-overall-badge--complete';
  if (status === 'failed' || status === 'partial_failure') return 'tt-overall-badge--failed';
  return 'tt-overall-badge--active';
}

export const RETRYABLE_STAGES: Set<PipelineStageType> = new Set(['upload:frameio', 'upload:leaderpass', 'transcript']);

export function isActive(entry: PipelineEntry): boolean {
  return !PIPELINE_TERMINAL_STATUSES.has(entry.overallStatus);
}

export function isWaiting(entry: PipelineEntry): boolean {
  if (entry.stages.length !== 1) return false;
  const s = entry.stages[0];
  return s.type === 'ingest' && (s.status === 'queued' || s.status === 'ingesting');
}

export function hasFailed(entry: PipelineEntry): boolean {
  return entry.overallStatus === 'failed' || entry.overallStatus === 'partial_failure';
}

export { PIPELINE_TERMINAL_STATUSES, STAGE_TERMINAL_STATUSES };
