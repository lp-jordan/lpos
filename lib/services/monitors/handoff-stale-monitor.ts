/**
 * HandoffStaleMonitor — fires re-pings on pending task handoffs that have sat
 * idle past the configured threshold.
 *
 * Each tick:
 *   1. SELECT pending handoffs where next_check_at <= now (partial-indexed —
 *      cheap regardless of how many completed handoffs exist).
 *   2. For each due handoff:
 *      • Notify every target assignee via type='handoff_stale' (in-app bell +
 *        Slack DM + web push, reusing the existing TaskNotificationService).
 *      • markAlerted(thresholdDays): bumps alert_count, sets last_alert_at,
 *        re-arms next_check_at = now + thresholdDays so the alarm fires again
 *        if they continue to sit idle.
 *
 * The alarm is only silenced by *real* activity (status change or comment by
 * a target assignee) — those hooks live in Phase 5 (PATCH /tasks and POST
 * /comments). Acknowledge from Phase 4 also resets next_check_at but does
 * NOT complete the handoff, so a still-silent ack'd handoff comes back here.
 *
 * Both the threshold (days) and the tick cadence (minutes) are admin-tunable
 * via lpos_settings — see SETTING_KEYS in lpos-settings-store.
 */

import type { Monitor } from '@/lib/services/monitor-registry';
import { getTaskStore, getTaskHandoffStore } from '@/lib/services/container';
import { notifyTaskEvent } from '@/lib/services/task-notification-service';
import { getUserById } from '@/lib/store/user-store';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';

export class HandoffStaleMonitor implements Monitor {
  readonly name = 'handoff-stale';
  readonly description =
    'Re-pings target assignees of pending task handoffs after the inactivity threshold.';
  readonly tickIntervalMs: number;

  constructor() {
    const minutes = getSetting<number>(
      SETTING_KEYS.HANDOFF_MONITOR_TICK_MINUTES,
      SETTING_DEFAULTS[SETTING_KEYS.HANDOFF_MONITOR_TICK_MINUTES],
    );
    // Defensive clamp: anything below 1 min is almost certainly a misconfig,
    // anything above 24h means the monitor is effectively disabled — use
    // the enable toggle instead.
    const clamped = Math.max(1, Math.min(24 * 60, Math.round(minutes)));
    this.tickIntervalMs = clamped * 60_000;
  }

  async tick(): Promise<void> {
    const handoffStore = getTaskHandoffStore();
    const taskStore    = getTaskStore();

    const now = new Date().toISOString();
    const due = handoffStore.listDue(now);
    if (due.length === 0) return;

    // Re-read threshold every tick so admin changes apply on the next cycle
    // without a restart.
    const thresholdDays = getSetting<number>(
      SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS,
      SETTING_DEFAULTS[SETTING_KEYS.HANDOFF_STALE_THRESHOLD_DAYS],
    );

    console.log(`[handoff-stale-monitor] ${due.length} handoff(s) due for re-ping`);

    for (const handoff of due) {
      // Defensive: if the task was deleted out from under the handoff (cascade
      // should have dropped the handoff too via FK ON DELETE CASCADE, but
      // belt-and-suspenders), skip + clear the next_check_at so we don't loop
      // forever on a phantom.
      const task = taskStore.getById(handoff.taskId);
      if (!task) {
        handoffStore.markCompleted(handoff.handoffId, 'manual');
        console.warn(`[handoff-stale-monitor] handoff ${handoff.handoffId} references missing task — closing as 'manual'`);
        continue;
      }

      const fromName = getUserById(handoff.fromUserId)?.name;
      // Notify every target — the alarm is on the handoff, not on individual
      // assignees, so we re-ping the full target set.
      await Promise.allSettled(
        handoff.toUserIds.map((uid) =>
          notifyTaskEvent({
            userId:     uid,
            type:       'handoff_stale',
            taskId:     handoff.taskId,
            taskTitle:  task.description,
            fromUserId: handoff.fromUserId,
            fromName,
          }),
        ),
      );

      handoffStore.markAlerted(handoff.handoffId, thresholdDays);
    }
  }
}
