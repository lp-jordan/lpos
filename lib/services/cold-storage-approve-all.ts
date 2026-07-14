/**
 * Cold-storage "Approve all" bulk-delete runner
 *
 * Approving every awaiting-review object is a serial B2 operation — one
 * ListObjectVersions + versioned delete per key. On a sizable review list that
 * takes minutes, far longer than a single HTTP request should block. This
 * module turns it into a guarded, non-blocking background run:
 *
 *   - startApproveAll() snapshots the queue, flips running=true, and drives the
 *     deletes WITHOUT awaiting (the POST route returns immediately).
 *   - A second call while a run is in progress is a no-op that returns the live
 *     progress with started=false — this is the guard against the double-click /
 *     concurrent-run race that previously spawned overlapping loops over the
 *     same queue.
 *   - getApproveAllProgress() exposes {running,total,done,failed,…} so the admin
 *     UI can poll (via the cold-storage overview endpoint) and show
 *     "Purging N of M" instead of an apparently-frozen "Approving…" spinner.
 *
 * State lives on globalThis so it survives Next.js dev HMR and is shared across
 * route module instances in the same Node process — same pattern the service
 * container uses.
 */

import { listQueuedForDeletion, type ColdStorageObject } from '@/lib/store/b2-cold-storage-store';
import { getB2SyncConfig } from '@/lib/store/b2-sync-config-store';
import { deleteOne } from '@/lib/services/b2-cold-storage-browser';

export interface ApproveAllProgress {
  /** True while the background loop is deleting. */
  running:    boolean;
  /** Objects snapshotted into this run (frozen at start). */
  total:      number;
  /** Successfully purged so far. */
  done:       number;
  /** Failed so far (kept in `errors`). */
  failed:     number;
  startedAt:  string | null;
  finishedAt: string | null;
  errors:     Array<{ key: string; error: string }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __lpos_coldStorageApproveAll: ApproveAllProgress | undefined;
}

function freshState(): ApproveAllProgress {
  return { running: false, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null, errors: [] };
}

function state(): ApproveAllProgress {
  if (!globalThis.__lpos_coldStorageApproveAll) {
    globalThis.__lpos_coldStorageApproveAll = freshState();
  }
  return globalThis.__lpos_coldStorageApproveAll;
}

/** Snapshot of the current bulk-approve progress (safe to serialise). */
export function getApproveAllProgress(): ApproveAllProgress {
  const s = state();
  return { ...s, errors: s.errors.slice(0, 50) };
}

/**
 * Kick off a bulk approve-delete of every object currently awaiting review.
 * Guarded: if a run is already in progress, this is a no-op and returns the
 * live progress with started=false. Otherwise it snapshots the queue, marks the
 * run active, and drives the deletes in the background (deliberately NOT awaited)
 * so the HTTP request returns immediately and the client polls for progress.
 */
export function startApproveAll(): { started: boolean; progress: ApproveAllProgress } {
  const current = state();
  if (current.running) {
    return { started: false, progress: getApproveAllProgress() };
  }

  const cfg    = getB2SyncConfig();
  const queued = listQueuedForDeletion(cfg.retainDays);
  const now    = new Date().toISOString();

  const next: ApproveAllProgress = {
    running:    queued.length > 0,
    total:      queued.length,
    done:       0,
    failed:     0,
    startedAt:  now,
    finishedAt: queued.length === 0 ? now : null,
    errors:     [],
  };
  globalThis.__lpos_coldStorageApproveAll = next;

  if (queued.length > 0) void runApproveAll(queued);
  return { started: true, progress: getApproveAllProgress() };
}

/**
 * Serial delete loop. Runs each object through the same single-object purge
 * path the per-row Approve uses. Failures are recorded per-key and do not abort
 * the batch — a partially-purged key stays awaiting review and can be retried.
 */
async function runApproveAll(queued: ColdStorageObject[]): Promise<void> {
  const s = state();
  for (const obj of queued) {
    try {
      await deleteOne(obj.key);
      s.done += 1;
    } catch (err) {
      s.failed += 1;
      s.errors.push({ key: obj.key, error: (err as Error).message });
    }
  }
  s.running    = false;
  s.finishedAt = new Date().toISOString();
  console.log(`[ColdStorage] approve-all done — ${s.done} purged, ${s.failed} failed of ${s.total}`);
}
