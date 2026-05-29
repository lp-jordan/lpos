/**
 * EpReleaseService
 *
 * Watches a directory for new EditPanel builds produced by electron-builder (on the
 * Windows machine) and makes them available for download by editpanel clients.
 * Sibling of LpReleaseService — EditPanel ships a Windows installer, so this watches
 * `latest.yml` (the Windows manifest) and serves an `.exe`.
 *
 * IMPORTANT — why this polls (LpReleaseService does not):
 *   The EditPanel build runs on the Windows machine and writes to a shared NAS
 *   folder; LPOS runs on the Mac. macOS `fs.watch` (FSEvents) does NOT reliably fire
 *   for files written by another host onto a network share, so polling is the
 *   primary pickup mechanism here. fs.watch is kept as a fast-path for the rare
 *   local-disk case. (LeaderPrompt builds on the same Mac, so its watcher suffices.)
 *
 * Flow:
 *   1. Admin sets watchDir in LPOS settings (the NAS folder the Windows build writes
 *      to, e.g. /Volumes/LeaderPass Main/LPOS/editpanel dist).
 *   2. The Windows build writes latest.yml + the .exe there.
 *   3. The poll (and an immediate pickup on start / on watchDir change) detects a new
 *      `version` in latest.yml, copies both files into /data/ep-releases/current/.
 *   4. Emits `ep-release:updated` so LPOS UI can refresh.
 *   5. editpanel clients / the /ep-update page see the new version and download it.
 *
 * Storage layout (under DATA_DIR):
 *   ep-releases/config.json           — { watchDir }
 *   ep-releases/status.json           — { version, installerFilename, lastUpdated }
 *   ep-releases/current/latest.yml
 *   ep-releases/current/*.exe
 */

import fs   from 'node:fs';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';

const DATA_DIR    = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const RELEASES_DIR = path.join(DATA_DIR, 'ep-releases');
const CURRENT_DIR  = path.join(RELEASES_DIR, 'current');
const CONFIG_PATH  = path.join(RELEASES_DIR, 'config.json');
const STATUS_PATH  = path.join(RELEASES_DIR, 'status.json');

// Poll the watch dir on this cadence. Cheap in steady state: just reads/parses the
// tiny latest.yml and no-ops unless the version (or installer filename) changed.
const POLL_INTERVAL_MS = 30_000;

export interface EpReleaseStatus {
  watchDir:          string | null;
  version:           string | null;
  installerFilename: string | null;
  lastUpdated:       string | null;
}

interface Config     { watchDir: string }
interface StatusFile { version: string; installerFilename: string; lastUpdated: string }

export class EpReleaseService {
  private watcher:  fs.FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll:     ReturnType<typeof setInterval> | null = null;
  private watchDir: string | null = null;
  private picking = false;

  constructor(private io: SocketIOServer) {}

  start() {
    fs.mkdirSync(CURRENT_DIR, { recursive: true });
    const cfg = this.readConfig();
    if (cfg?.watchDir) this.beginWatching(cfg.watchDir);
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    if (this.poll)     { clearInterval(this.poll);    this.poll = null; }
  }

  setWatchDir(dir: string) {
    this.stop();
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ watchDir: dir }, null, 2));
    this.beginWatching(dir);
  }

  getStatus(): EpReleaseStatus {
    const cfg    = this.readConfig();
    const status = this.readStatus();
    return {
      watchDir:          cfg?.watchDir          ?? null,
      version:           status?.version           ?? null,
      installerFilename: status?.installerFilename ?? null,
      lastUpdated:       status?.lastUpdated       ?? null,
    };
  }

  getCurrentDir() { return CURRENT_DIR; }

  // ── Private ────────────────────────────────────────────────────────────────

  private beginWatching(dir: string) {
    this.watchDir = dir;
    this.startFsWatch(dir);   // fast-path (local disk); may be a no-op on a NAS
    // Reliable path: poll, plus an immediate pickup so an already-present build
    // (or one written before the watcher attached) is picked up right away.
    this.poll = setInterval(() => { void this.pickUpRelease(); }, POLL_INTERVAL_MS);
    void this.pickUpRelease();
  }

  private startFsWatch(dir: string) {
    if (!fs.existsSync(dir)) {
      console.warn(`[EpReleaseService] watch dir not present yet (will poll): ${dir}`);
      return;
    }
    try {
      this.watcher = fs.watch(dir, (event, filename) => {
        if (filename !== 'latest.yml') return;
        if (this.debounce) clearTimeout(this.debounce);
        // Debounce: electron-builder writes yml last, but give it 500 ms to finish.
        this.debounce = setTimeout(() => { void this.pickUpRelease(); }, 500);
      });
      this.watcher.on('error', (err) => {
        console.error('[EpReleaseService] watcher error:', err);
      });
    } catch (err) {
      console.warn('[EpReleaseService] fs.watch unavailable (will poll):', err);
    }
  }

  private async pickUpRelease() {
    if (!this.watchDir) return;
    if (this.picking) return;          // avoid overlapping copies (watch + poll)
    this.picking = true;
    try {
      const ymlSrc = path.join(this.watchDir, 'latest.yml');
      if (!fs.existsSync(ymlSrc)) return;

      let ymlText: string;
      try { ymlText = fs.readFileSync(ymlSrc, 'utf8'); }
      catch { return; }

      const version           = this.parseYmlField(ymlText, 'version');
      const installerFilename = this.parseYmlField(ymlText, 'path');
      if (!version || !installerFilename) {
        console.warn('[EpReleaseService] could not parse version/path from latest.yml');
        return;
      }

      // Idempotent: if we already serve this exact build, do nothing. Keeps the
      // 30 s poll cheap and avoids re-copying the (large) .exe every tick.
      const current = this.readStatus();
      const alreadyServed =
        current?.version === version &&
        current?.installerFilename === installerFilename &&
        fs.existsSync(path.join(CURRENT_DIR, installerFilename));
      if (alreadyServed) return;

      const exeSrc = path.join(this.watchDir, installerFilename);
      if (!fs.existsSync(exeSrc)) {
        console.warn(`[EpReleaseService] installer not found: ${exeSrc}`);
        return;
      }

      fs.mkdirSync(CURRENT_DIR, { recursive: true });
      // Remove old installer(s) before copying the new one
      for (const f of fs.readdirSync(CURRENT_DIR)) {
        if (f.endsWith('.exe')) fs.rmSync(path.join(CURRENT_DIR, f), { force: true });
      }

      fs.copyFileSync(ymlSrc, path.join(CURRENT_DIR, 'latest.yml'));
      fs.copyFileSync(exeSrc, path.join(CURRENT_DIR, installerFilename));

      const lastUpdated = new Date().toISOString();
      fs.writeFileSync(STATUS_PATH, JSON.stringify({ version, installerFilename, lastUpdated }, null, 2));

      console.log(`[EpReleaseService] picked up EditPanel v${version} (${installerFilename})`);
      this.io.emit('ep-release:updated', { version, installerFilename, lastUpdated });
    } finally {
      this.picking = false;
    }
  }

  /** Parses `key: value` lines from a simple YAML file (no library needed). */
  private parseYmlField(yml: string, key: string): string | null {
    const match = yml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
  }

  private readConfig(): Config | null {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return null;
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
    } catch { return null; }
  }

  private readStatus(): StatusFile | null {
    try {
      if (!fs.existsSync(STATUS_PATH)) return null;
      return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as StatusFile;
    } catch { return null; }
  }
}
