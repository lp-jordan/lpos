export type ActivityVisibility = 'user_timeline' | 'operator_only' | 'debug_only';

export type ActivitySourceKind =
  | 'api'
  | 'ui'
  | 'background_service'
  | 'scheduled_job'
  | 'external_poll'
  | 'external_webhook'
  | 'migration'
  | 'manual_admin';

export type ActivityActorType =
  | 'user'
  | 'system'
  | 'service'
  | 'external_user'
  | 'external_system'
  | 'agent';

export type ActivityLifecyclePhase =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'updated'
  | 'commented'
  | 'superseded';

export type NotificationSeverity = 'info' | 'warning' | 'error';
export type NotificationCandidateStatus = 'pending' | 'dismissed' | 'delivered';

export interface ActivityActor {
  actor_type: ActivityActorType;
  actor_id?: string | null;
  actor_display?: string | null;
}

export interface ActivityEventInput extends ActivityActor {
  event_id?: string;
  occurred_at: string;
  event_type: string;
  lifecycle_phase: ActivityLifecyclePhase;
  source_kind: ActivitySourceKind;
  visibility: ActivityVisibility;
  title: string;
  client_id?: string | null;
  project_id?: string | null;
  asset_id?: string | null;
  job_id?: string | null;
  service_id?: string | null;
  source_service?: string | null;
  source_id?: string | null;
  correlation_id?: string | null;
  causation_event_id?: string | null;
  summary?: string | null;
  details_json?: Record<string, unknown>;
  impact_json?: Record<string, unknown>;
  search_text?: string | null;
  dedupe_key?: string | null;
}

export interface ActivityEventRecord extends Required<ActivityActor> {
  event_id: string;
  recorded_at: string;
  occurred_at: string;
  event_type: string;
  lifecycle_phase: ActivityLifecyclePhase;
  source_kind: ActivitySourceKind;
  visibility: ActivityVisibility;
  title: string;
  client_id: string | null;
  project_id: string | null;
  asset_id: string | null;
  job_id: string | null;
  service_id: string | null;
  source_service: string | null;
  source_id: string | null;
  correlation_id: string | null;
  causation_event_id: string | null;
  summary: string | null;
  details_json: Record<string, unknown>;
  impact_json: Record<string, unknown>;
  search_text: string | null;
  dedupe_key: string | null;
}

export interface ActivityQueryOptions {
  limit?: number;
  visibility?: ActivityVisibility[];
}
