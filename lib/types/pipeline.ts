export type PipelineStageType = 'ingest' | 'transcript' | 'upload:frameio' | 'upload:leaderpass' | 'promotion';

export interface PipelineStage {
  type: PipelineStageType;
  jobId: string;
  status: string;
  progress: number;
  error?: string;
  detail?: string;
  queuedAt: string;
  updatedAt: string;
  completedAt?: string;
  stalled: boolean;
}

export type PipelineOverallStatus =
  | 'ingesting'
  | 'transcribing'
  | 'uploading_frameio'
  | 'uploading_leaderpass'
  | 'processing'
  | 'complete'
  | 'partial_failure'
  | 'failed'
  | 'cancelled';

export interface PipelineEntry {
  pipelineId: string;
  assetId: string | null;
  projectId: string;
  projectName: string;
  filename: string;
  overallStatus: PipelineOverallStatus;
  stages: PipelineStage[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export const PIPELINE_TERMINAL_STATUSES = new Set<PipelineOverallStatus>([
  'complete', 'partial_failure', 'failed', 'cancelled',
]);

export const STAGE_TERMINAL_STATUSES = new Set([
  'done', 'failed', 'cancelled', 'canceled',
]);
