/**
 * Socket.io broadcasts for task mutations.
 *
 * Emitted from the API routes after a successful store operation. Every
 * connected `/tasks` client receives the event — they merge it into local
 * state idempotently (the originator's optimistic-update path just gets
 * confirmed; everyone else's view stays fresh without a refresh).
 *
 * Best-effort: if the io server isn't initialised yet (rare race during
 * startup), emit is a no-op. Clients will still see the right state on
 * their next list refresh.
 */

import type { Task } from '@/lib/models/task';
import { getIo } from '@/lib/services/container';

const NAMESPACE = '/tasks';

function namespace() {
  return getIo()?.of(NAMESPACE) ?? null;
}

export function emitTaskCreated(task: Task): void {
  namespace()?.emit('task:created', task);
}

export function emitTaskUpdated(task: Task): void {
  namespace()?.emit('task:updated', task);
}

export function emitTaskDeleted(taskId: string): void {
  namespace()?.emit('task:deleted', { taskId });
}

/**
 * Working-calendar day overrides (skip / work a date).
 *
 * Deliberately rides the `/tasks` namespace rather than opening a second one:
 * the only consumer is the task board, which already holds that socket, and a
 * day override is a change to how that board reads. `working: null` means the
 * override was cleared and the day reverts to the default weekly pattern.
 */
export function emitCalendarDayChanged(date: string, working: boolean | null): void {
  namespace()?.emit('calendar-day:changed', { date, working });
}
