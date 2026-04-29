export type CanonicalAssetStatus = 'active' | 'archived' | 'provisional' | 'error';
export type CanonicalVersionStatus =
  | 'registered'
  | 'ingested'
  | 'processing'
  | 'ready'
  | 'published'
  | 'superseded'
  | 'duplicate'
  | 'error';
export type CanonicalIngestMode = 'announced' | 'observed' | 'manual';
export type CanonicalWritebackStatus = 'not_attempted' | 'pending' | 'written' | 'failed';
export type CanonicalDisplacementStatus = 'normal' | 'source_missing' | 'managed_missing' | 'both_missing' | 'relinked';
export type CanonicalDistributionProvider = 'frameio' | 'cloudflare' | 'leaderpass' | 'sardius';
export type CanonicalStorageClass = 'nas' | 'local_upload' | 'managed_copy' | 'frameio_fallback';
export type CanonicalMediaRole = 'primary' | 'proxy' | 'derived';

export interface CanonicalAsset {
  asset_id: string;
  project_id: string;
  client_code: string | null;
  display_label: string | null;
  current_display_name: string;
  description: string;
  tags_json: string;
  status: CanonicalAssetStatus;
  source_system: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  migration_source: string | null;
  migrated_at: string | null;
}

export interface CanonicalEditorialLink {
  editorial_link_id: string;
  asset_id: string;
  resolve_project_name: string | null;
  resolve_project_id: string | null;
  resolve_timeline_name: string | null;
  resolve_timeline_unique_id: string | null;
  editpanel_task_id: string | null;
  registered_by: string | null;
  registered_at: string | null;
  writeback_status: CanonicalWritebackStatus;
  writeback_error: string | null;
  last_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalAssetVersion {
  asset_version_id: string;
  asset_id: string;
  version_number: number;
  version_label: string | null;
  ingest_mode: CanonicalIngestMode;
  status: CanonicalVersionStatus;
  exported_at: string | null;
  ingested_at: string;
  export_preset: string | null;
  edit_label_at_export: string | null;
  source_event_id: string | null;
  replaced_by_version_id: string | null;
  supersedes_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalMediaFile {
  media_file_id: string;
  asset_version_id: string;
  role: CanonicalMediaRole;
  source_path: string | null;
  managed_path: string | null;
  storage_class: CanonicalStorageClass;
  original_filename: string;
  managed_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  content_hash: string | null;
  duration_seconds: number | null;
  source_modified_at: string | null;
  copied_to_managed_at: string | null;
  is_source_available: number;
  is_managed_available: number;
  displacement_status: CanonicalDisplacementStatus;
  created_at: string;
  updated_at: string;
}

export interface CanonicalDistributionRecord {
  distribution_record_id: string;
  asset_version_id: string;
  provider: CanonicalDistributionProvider;
  provider_status: string;
  provider_asset_id: string | null;
  provider_parent_id: string | null;
  attempt_number: number;
  published_at: string | null;
  ready_at: string | null;
  last_error: string | null;
  playback_url: string | null;
  review_url: string | null;
  thumbnail_url: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalDistributionAttachment {
  distribution_attachment_id: string;
  distribution_record_id: string;
  attachment_type: string;
  external_parent_id: string;
  external_child_id: string;
  created_at: string;
  updated_at: string;
}

export interface CanonicalIngestException {
  ingest_exception_id: string;
  project_id: string;
  asset_id: string | null;
  asset_version_id: string | null;
  severity: string;
  exception_type: string;
  summary: string;
  details_json: string | null;
  source_path: string | null;
  managed_path: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolution_status: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalTranscriptionJob {
  transcription_job_id: string;
  asset_version_id: string;
  status: string;
  job_id: string | null;
  provider: string | null;
  completed_at: string | null;
  last_error: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}
