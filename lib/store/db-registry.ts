/**
 * SQLite durability: WAL checkpoint management.
 *
 * Background: every store opens a `node:sqlite` DatabaseSync in WAL mode and
 * caches it as a `globalThis` singleton. The app never issued a checkpoint and
 * never closed these handles, so written data accumulated in the `-wal` sidecar
 * and (for low-write DBs) never folded into the main `.sqlite` file — leaving the
 * main file a 4 KB empty shell whose data lived ENTIRELY in the fragile WAL. If
 * the WAL is lost on restart, that data is gone.
 *
 * This module makes the main file durable by checkpointing explicitly:
 *  - `startCheckpointTimer()` folds the WAL into the main file every ~60 s, so a
 *    crash / hard-kill / lost WAL costs at most the last interval, never the DB.
 *  - `checkpointAllDatabases('TRUNCATE')` + `closeAllDatabases()` run on graceful
 *    shutdown so a clean restart always leaves a complete main file.
 *
 * DBs are discovered generically by scanning `globalThis` for DatabaseSync
 * instances, so no per-store registration is required.
 */

import { DatabaseSync } from 'node:sqlite';

export type CheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';

export interface CheckpointOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

/** Every open SQLite singleton (each store caches its handle on globalThis). */
function openDatabases(): Array<{ name: string; db: DatabaseSync }> {
  const found: Array<{ name: string; db: DatabaseSync }> = [];
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(g)) {
    let value: unknown;
    try { value = g[key]; } catch { continue; } // some globals throw on access
    if (value instanceof DatabaseSync) found.push({ name: key, db: value });
  }
  return found;
}

/**
 * Fold each database's WAL into its main file. PASSIVE (default) never blocks on
 * other activity; TRUNCATE also shrinks the WAL file (use on shutdown). Errors
 * are captured per-DB, never thrown — a checkpoint failure must not crash the app.
 */
export function checkpointAllDatabases(mode: CheckpointMode = 'PASSIVE'): CheckpointOutcome[] {
  const outcomes: CheckpointOutcome[] = [];
  for (const { name, db } of openDatabases()) {
    try {
      db.exec(`PRAGMA wal_checkpoint(${mode});`);
      outcomes.push({ name, ok: true });
    } catch (err) {
      outcomes.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

/** Final checkpoint (TRUNCATE) + close of every open DB — for graceful shutdown. */
export function closeAllDatabases(): CheckpointOutcome[] {
  const outcomes: CheckpointOutcome[] = [];
  for (const { name, db } of openDatabases()) {
    try {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* still try to close */ }
      db.close();
      outcomes.push({ name, ok: true });
    } catch (err) {
      outcomes.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

// ── Periodic checkpoint timer ────────────────────────────────────────────────

const CHECKPOINT_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startCheckpointTimer(intervalMs: number = CHECKPOINT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    const outcomes = checkpointAllDatabases('PASSIVE');
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length) {
      console.warn('[db-checkpoint] some checkpoints failed:', failed.map((f) => `${f.name}: ${f.error}`).join('; '));
    }
  }, intervalMs);
  // Don't let the checkpoint timer hold the process open on exit.
  (timer as { unref?: () => void }).unref?.();
  console.log(`[db-checkpoint] periodic WAL checkpoint every ${Math.round(intervalMs / 1000)}s`);
}

export function stopCheckpointTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
