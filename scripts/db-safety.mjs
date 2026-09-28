#!/usr/bin/env node
/**
 * db-safety — guard the LPOS SQLite databases around restarts and rebuilds.
 *
 * Called by the LPOS Server app (lpos-server-app/main.js):
 *   snapshot                 before every rebuild (after LPOS has stopped)
 *   check --strict           after a rebuild, before LPOS is started again
 *   check --missing-only     before every other automatic start (nightly, crash restart…)
 *
 * snapshot  VACUUM INTOs every data/*.sqlite into
 *           ../lpos-db-safety-snapshots/rebuild-<UTC time>/ plus manifest.json
 *           (bytes + per-table row counts). Keeps the newest 10 rebuild-* dirs.
 * check     compares data/ with the newest snapshot manifest:
 *             missing-only — any DB in the manifest that no longer exists → FAIL
 *             strict       — also FAIL when a DB lost > half its rows (DBs with
 *                            ≥ 100 rows) — only safe right after a snapshot,
 *                            since queues legitimately shrink over days.
 *           Exit 0 = OK, 2 = FAIL (the server app then refuses to start LPOS).
 *
 * Why: on 2026-09-28 data/lpos-activity.sqlite vanished during a rebuild and
 * LPOS silently created an empty one at startup; the startup backup then
 * overwrote that day's good R2 copy. Never opening a DB that is missing (and
 * logging what exists at each step) stops that, and helps find the cause.
 *
 * Plain Node (node:sqlite) — no build step, so it works even if the build fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(ROOT, 'data');
const SNAP_ROOT = process.env.LPOS_DB_SNAPSHOT_DIR ?? path.join(ROOT, '..', 'lpos-db-safety-snapshots');
const KEEP = 10;
const SHRINK_MIN_ROWS = 100;
const SHRINK_RATIO = 0.5;

const [cmd, ...flags] = process.argv.slice(2);

function listDbs() {
  return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.sqlite')).sort();
}

/** Sizes of each DB file and its -wal (logged at every step, to catch a deleter). */
function presenceLine(names) {
  return names.map((n) => {
    const p = path.join(DATA_DIR, n);
    if (!fs.existsSync(p)) return `${n}=MISSING`;
    const wal = fs.existsSync(`${p}-wal`) ? fs.statSync(`${p}-wal`).size : 0;
    return `${n}=${fs.statSync(p).size}${wal ? `+wal${wal}` : ''}`;
  }).join(' ');
}

/** Row count of every table. Only called on files known to exist (opening a missing path would create it). */
function rowCounts(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const counts = {};
    for (const { name } of tables) counts[name] = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get().c;
    return counts;
  } finally {
    db.close();
  }
}

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

function newestSnapshot() {
  if (!fs.existsSync(SNAP_ROOT)) return null;
  const dirs = fs.readdirSync(SNAP_ROOT).filter((d) => d.startsWith('rebuild-') && fs.existsSync(path.join(SNAP_ROOT, d, 'manifest.json'))).sort();
  if (!dirs.length) return null;
  const dir = path.join(SNAP_ROOT, dirs[dirs.length - 1]);
  return { dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) };
}

function snapshot() {
  const names = listDbs();
  console.log(`[db-safety] before snapshot: ${presenceLine(names)}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(SNAP_ROOT, `rebuild-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { takenAt: new Date().toISOString(), dataDir: DATA_DIR, dbs: {} };
  let failed = 0;
  for (const n of names) {
    const src = path.join(DATA_DIR, n);
    try {
      const db = new DatabaseSync(src);
      try {
        db.exec('PRAGMA busy_timeout = 2000');
        db.prepare('VACUUM INTO ?').run(path.join(dir, n));
      } finally { db.close(); }
      const counts = rowCounts(path.join(dir, n));
      manifest.dbs[n] = { bytes: fs.statSync(path.join(dir, n)).size, rows: total(counts), tables: counts };
    } catch (err) {
      failed++;
      manifest.dbs[n] = { error: err.message };
      console.error(`[db-safety] snapshot of ${n} failed: ${err.message}`);
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const summary = Object.entries(manifest.dbs).map(([n, d]) => (d.error ? `${n}=ERR` : `${n}=${d.rows}rows`)).join(' ');
  console.log(`[db-safety] snapshot ${path.basename(dir)}: ${summary}`);

  // Keep the newest KEEP rebuild snapshots.
  const all = fs.readdirSync(SNAP_ROOT).filter((d) => d.startsWith('rebuild-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(SNAP_ROOT, old), { recursive: true, force: true });
  return failed ? 1 : 0;
}

function check(strict) {
  const snap = newestSnapshot();
  const names = listDbs();
  console.log(`[db-safety] before start: ${presenceLine(snap ? [...new Set([...Object.keys(snap.manifest.dbs), ...names])].sort() : names)}`);
  if (!snap) { console.log('[db-safety] no snapshot to compare against — OK'); return 0; }

  const problems = [];
  for (const [n, before] of Object.entries(snap.manifest.dbs)) {
    if (before.error) continue;
    const file = path.join(DATA_DIR, n);
    if (!fs.existsSync(file)) { problems.push(`${n} is MISSING (had ${before.rows} rows at ${snap.manifest.takenAt})`); continue; }
    if (!strict) continue;
    try {
      const now = total(rowCounts(file));
      if (before.rows >= SHRINK_MIN_ROWS && now < before.rows * SHRINK_RATIO) {
        problems.push(`${n} shrank from ${before.rows} to ${now} rows since ${snap.manifest.takenAt}`);
      }
    } catch (err) {
      problems.push(`${n} can't be read: ${err.message}`);
    }
  }
  if (problems.length) {
    console.error(`[db-safety] FAIL — ${problems.join('; ')}. Restore from Litestream or ${snap.dir} before starting.`);
    return 2;
  }
  console.log(`[db-safety] OK (${strict ? 'strict' : 'missing-only'}) vs ${path.basename(snap.dir)}`);
  return 0;
}

let code = 0;
try {
  if (cmd === 'snapshot') code = snapshot();
  else if (cmd === 'check') code = check(!flags.includes('--missing-only'));
  else { console.error('usage: db-safety.mjs snapshot | check [--strict|--missing-only]'); code = 64; }
} catch (err) {
  console.error(`[db-safety] error: ${err.message}`);
  code = 1;
}
process.exit(code);
