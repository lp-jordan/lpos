import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ActivityMonitorService, setActivityMonitorService } from '@/lib/services/activity-monitor-service';
import { getActivityDb, getActivityDbPath, resetActivityDbForTests } from '@/lib/store/activity-db';

function cleanupDb() {
  resetActivityDbForTests();
  const dbPath = getActivityDbPath();
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  for (const target of [dbPath, walPath, shmPath]) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // ignore cleanup failures
    }
  }
  setActivityMonitorService(undefined);
}

function createService(options?: ConstructorParameters<typeof ActivityMonitorService>[2]) {
  return new ActivityMonitorService(undefined, null, options);
}

test.beforeEach(() => {
  cleanupDb();
});

test.after(() => {
  cleanupDb();
});

test('activity DB initializes core tables idempotently', () => {
  const db = getActivityDb();
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('activity_events', 'project_current_state', 'entity_latest_status', 'notification_candidates', 'activity_summary_windows')
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(tables.map((table) => table.name), [
    'activity_events',
    'activity_summary_windows',
    'entity_latest_status',
    'notification_candidates',
    'project_current_state',
  ]);

  const dbAgain = getActivityDb();
  assert.equal(db, dbAgain);
});

test('recordActivity writes ledger rows and project timeline entries', () => {
  const service = createService();
  const result = service.recordActivity({
    actor_type: 'user',
    actor_id: 'jordan',
    actor_display: 'Jordan',
    occurred_at: '2026-03-25T10:00:00.000Z',
    event_type: 'asset.registered',
    lifecycle_phase: 'created',
    source_kind: 'api',
    visibility: 'user_timeline',
    title: 'Asset registered: Promo Cut',
    summary: 'Jordan registered Promo Cut',
    client_id: 'Acme',
    project_id: 'project-1',
    asset_id: 'asset-1',
    search_text: 'Jordan Promo Cut',
  });

  assert.equal(result.inserted, true);

  const activity = service.listProjectActivity('project-1');
  assert.equal(activity.length, 1);
  assert.equal(activity[0]?.actor_id, 'jordan');
  assert.equal(activity[0]?.event_type, 'asset.registered');

  const projectState = getActivityDb().prepare(`
    SELECT current_status, last_user_actor_id
    FROM project_current_state
    WHERE project_id = ?
  `).get('project-1') as { current_status: string; last_user_actor_id: string };

  assert.equal(projectState.current_status, 'created');
  assert.equal(projectState.last_user_actor_id, 'jordan');
});

test('external dedupe keys prevent duplicate comment events and notification spam', () => {
  const service = createService();
  const input = {
    actor_type: 'external_user' as const,
    actor_display: 'Alex',
    occurred_at: '2026-03-25T11:00:00.000Z',
    event_type: 'frameio.comment.created',
    lifecycle_phase: 'commented' as const,
    source_kind: 'external_poll' as const,
    visibility: 'user_timeline' as const,
    title: 'New comment on Promo Cut in Frame.io',
    summary: 'Alex commented on Promo Cut',
    client_id: 'Acme',
    project_id: 'project-1',
    asset_id: 'asset-1',
    dedupe_key: 'frameio-comment:file-1:comment-1',
  };

  assert.equal(service.recordExternalActivity(input).inserted, true);
  assert.equal(service.recordExternalActivity(input).inserted, false);

  const counts = getActivityDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM activity_events) AS event_count,
      (SELECT COUNT(*) FROM notification_candidates) AS notification_count
  `).get() as { event_count: number; notification_count: number };

  assert.equal(counts.event_count, 1);
  assert.equal(counts.notification_count, 1);
});

test('generateSummaries creates project daily and client weekly summaries without deleting raw events', async () => {
  const service = createService();
  service.recordActivity({
    actor_type: 'service',
    actor_display: 'Transcripter',
    occurred_at: '2026-03-24T09:00:00.000Z',
    event_type: 'transcription.completed',
    lifecycle_phase: 'completed',
    source_kind: 'background_service',
    visibility: 'user_timeline',
    title: 'Transcription completed: Promo Cut',
    client_id: 'Acme',
    project_id: 'project-1',
    asset_id: 'asset-1',
    job_id: 'job-1',
  });
  service.recordActivity({
    actor_type: 'service',
    actor_display: 'Frame.io Upload',
    occurred_at: '2026-03-25T09:00:00.000Z',
    event_type: 'frameio.upload.completed',
    lifecycle_phase: 'completed',
    source_kind: 'background_service',
    visibility: 'user_timeline',
    title: 'Frame.io upload completed: Promo Cut',
    client_id: 'Acme',
    project_id: 'project-1',
    asset_id: 'asset-1',
    job_id: 'job-2',
  });

  await service.generateSummaries();

  const counts = getActivityDb().prepare(`
    SELECT
      (SELECT COUNT(*) FROM activity_events) AS event_count,
      (SELECT COUNT(*) FROM activity_summary_windows WHERE summary_kind = 'daily_project') AS daily_count,
      (SELECT COUNT(*) FROM activity_summary_windows WHERE summary_kind = 'weekly_client') AS weekly_count
  `).get() as { event_count: number; daily_count: number; weekly_count: number };

  assert.equal(counts.event_count, 2);
  assert.equal(counts.daily_count, 2);
  assert.equal(counts.weekly_count, 1);
});
