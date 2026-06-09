/**
 * MediaCommentMirrorService — Phase 2 of the local-first comments refactor.
 *
 * See docs/local-comments-refactor-spec.md §6.1 for the full design.
 *
 * What it does:
 *   - Wakes every TICK_MS, pulls pending mirror jobs whose `next_attempt_at`
 *     has elapsed, and runs each job against the Frame.io API.
 *   - On success: writes the Frame.io comment id back to the local row.
 *   - On failure: records the error, schedules the next retry per the
 *     exponential-backoff schedule, OR marks 'abandoned' once the cumulative
 *     attempt window crosses 3 hours (locked decision §11 #7).
 *
 * What it does NOT do:
 *   - Mirror replies (locked decision §11 #2). Replies stay LPOS-only;
 *     the write-path handlers never enqueue 'create' jobs for replies, so
 *     the queue mechanically can't surface them here. If a stray reply ever
 *     hits this worker, we skip + log.
 *   - Read from Frame.io (that's inbound webhook territory).
 *   - Retry abandoned jobs automatically — locked §11 #7 says manual only,
 *     and we deferred the Retry UI to a future phase, so abandoned stays
 *     abandoned until an operator intervenes via direct DB action.
 */

import { getMediaCommentById, setFrameioIdOnComment, getPendingMirrorJobs, markMirrorJobInFlight, markMirrorJobSucceeded, recordMirrorJobFailure } from '@/lib/store/media-comment-store';
import { postComment, updateComment, toggleCommentCompleted, deleteComment } from '@/lib/services/frameio';
import type { MediaCommentMirrorJob } from '@/lib/models/media-comment';

const TICK_MS = 5_000;  // wake every 5 seconds — small enough that LPOS users see clients' mirror reflection quickly; cheap enough that an empty queue costs ~nothing.

export class MediaCommentMirrorService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;  // single in-flight tick — we don't want overlapping drains hammering Frame.io

  start(): void {
    if (this.timer) return;
    console.log('[MediaCommentMirrorService] starting');
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const jobs = getPendingMirrorJobs(5);
      for (const job of jobs) {
        await this.processJob(job);
      }
    } catch (err) {
      console.warn('[MediaCommentMirrorService] tick error:', (err as Error).message);
    } finally {
      this.inFlight = false;
    }
  }

  private async processJob(job: MediaCommentMirrorJob): Promise<void> {
    // Mark in flight so concurrent ticks (shouldn't happen — inFlight guard
    // above — but cheap insurance) can't grab the same job.
    markMirrorJobInFlight(job.jobId);

    const comment = getMediaCommentById(job.commentId);
    if (!comment) {
      // Comment was hard-deleted before the mirror could land. Mark succeeded
      // so the queue doesn't keep retrying a vanished row.
      markMirrorJobSucceeded(job.jobId);
      return;
    }

    // Replies are LPOS-only (locked §11 #2) — should never reach this worker.
    if (comment.parentCommentId && job.action === 'create') {
      console.warn(`[MediaCommentMirrorService] stray reply create job ${job.jobId} for comment ${comment.commentId} — replies aren't mirrored; marking succeeded.`);
      markMirrorJobSucceeded(job.jobId);
      return;
    }

    try {
      switch (job.action) {
        case 'create': {
          if (!comment.frameioFileId) {
            throw new Error(`comment ${comment.commentId} has no frameio_file_id; cannot mirror`);
          }
          const created = await postComment(
            comment.frameioFileId,
            comment.body,
            comment.timestampSeconds,
            comment.durationSeconds,
          );
          setFrameioIdOnComment(comment.commentId, created.id, comment.frameioFileId);
          markMirrorJobSucceeded(job.jobId);
          return;
        }
        case 'update': {
          if (!comment.frameioCommentId) {
            throw new Error(`comment ${comment.commentId} has no frameio_comment_id yet; deferring update`);
          }
          await updateComment(comment.frameioCommentId, comment.body);
          markMirrorJobSucceeded(job.jobId);
          return;
        }
        case 'complete':
        case 'uncomplete': {
          if (!comment.frameioCommentId) {
            throw new Error(`comment ${comment.commentId} has no frameio_comment_id yet; deferring completion`);
          }
          await toggleCommentCompleted(comment.frameioCommentId, job.action === 'complete');
          markMirrorJobSucceeded(job.jobId);
          return;
        }
        case 'delete': {
          if (!comment.frameioCommentId) {
            // Nothing to delete on Frame.io if the create never landed.
            markMirrorJobSucceeded(job.jobId);
            return;
          }
          await deleteComment(comment.frameioCommentId);
          markMirrorJobSucceeded(job.jobId);
          return;
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      const { abandoned } = recordMirrorJobFailure(job.jobId, msg);
      if (abandoned) {
        console.warn(`[MediaCommentMirrorService] ABANDONED job ${job.jobId} (comment=${comment.commentId} action=${job.action}) after 3h — ${msg}`);
      } else {
        console.warn(`[MediaCommentMirrorService] retrying job ${job.jobId} (action=${job.action}): ${msg}`);
      }
    }
  }
}
