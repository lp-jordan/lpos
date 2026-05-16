/**
 * Activity buckets — four coarse categories users care about, derived from
 * the granular event_type values that emitters write to activity_events.
 *
 * The strip and history modal filter on these buckets instead of raw event
 * types so the picker stays useful as the event vocabulary grows. Add new
 * event_types to the mapping below as they're introduced.
 *
 * Default surfaced bucket = 'tasks'.
 */

export type ActivityBucket = 'tasks' | 'media' | 'uploads' | 'service_jobs';

export const ACTIVITY_BUCKETS: Array<{ value: ActivityBucket; label: string }> = [
  { value: 'tasks',        label: 'Tasks' },
  { value: 'media',        label: 'Media' },
  { value: 'uploads',      label: 'Uploads' },
  { value: 'service_jobs', label: 'Service Jobs' },
];

export const DEFAULT_ACTIVITY_BUCKET: ActivityBucket = 'tasks';

/**
 * Map a raw event_type to a bucket. Unknown event types return null so the
 * caller can decide whether to surface them under "all" or hide them entirely.
 */
export function eventTypeToBucket(eventType: string): ActivityBucket | null {
  if (eventType.startsWith('task.')) return 'tasks';

  if (eventType.startsWith('asset.')) return 'media';
  if (eventType.startsWith('frameio.comment.')) return 'media';
  if (eventType.startsWith('project.')) return 'media';

  if (eventType.startsWith('frameio.upload.')) return 'uploads';
  if (eventType.startsWith('leaderpass.publish.')) return 'uploads';

  if (eventType.startsWith('transcription.')) return 'service_jobs';
  if (eventType.startsWith('ingest.')) return 'service_jobs';

  return null;
}

/**
 * SQL LIKE prefixes for each bucket — used by the API to filter at the
 * query layer rather than fetching everything and filtering in memory.
 * Keep in sync with eventTypeToBucket(); the function and these prefixes
 * are two views of the same mapping.
 */
export const BUCKET_EVENT_PREFIXES: Record<ActivityBucket, string[]> = {
  tasks:        ['task.'],
  media:        ['asset.', 'frameio.comment.', 'project.'],
  uploads:      ['frameio.upload.', 'leaderpass.publish.'],
  service_jobs: ['transcription.', 'ingest.'],
};
