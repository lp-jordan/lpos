/**
 * LpReleaseService
 *
 * Watches a local directory for new LeaderPrompt builds produced by
 * electron-builder and makes them available for download by LP clients.
 *
 * Flow:
 *   1. Admin configures watchDir in LPOS settings (the LP project's release/ output).
 *   2. Developer runs `electron-builder` on the host machine.
 *   3. electron-builder writes latest-mac.yml + *.dmg to watchDir.
 *   4. This service detects latest-mac.yml, parses version + dmg filename,
 *      copies both files into /data/lp-releases/current/.
 *   5. Emits `lp-release:updated` socket event so LPOS UI can refresh.
 *   6. LP clients poll /api/lp-updates/version, see the new version, and
 *      show the update banner.
 *
 * Storage layout (under DATA_DIR):
 *   lp-releases/config.json           — { watchDir }
 *   lp-releases/status.json           — { version, dmgFilename, lastUpdated }
 *   lp-releases/current/latest-mac.yml
 *   lp-releases/current/*.dmg
 */

import fs   from 'node:fs';
import path from 'node:path';
import type { Server as SocketIOServer } from 'socket.io';

const DATA_DIR    = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const RELEASES_DIR = path.join(DATA_DIR, 'lp-releases');
const CURRENT_DIR  = path.join(RELEASES_DIR, 'current');
const CONFIG_PATH  = path.join(RELEASES_DIR, 'config.json');
const STATUS_PATH  = path.join(RELEASES_DIR, 'status.json');

export interface LpReleaseStatus {
  watchDir:    string | null;
  version:     string | null;
  dmgFilename: string | null;
  lastUpdated: string | null;
}

interface Config   { watchDir: string }
interface StatusFile { version: string; dmgFilename: string; lastUpdated: string }

export class LpReleaseService {
  private watcher:  fs.FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private watchDir: string | null = null;

  constructor(private io: SocketIOServer) {}

  start() {
    fs.mkdirSync(CURRENT_DIR, { recursive: true });
    const cfg = this.readConfig();
    if (cfg?.watchDir) this.startWatcher(cfg.watchDir);
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
  }

  setWatchDir(dir: string) {
    this.stop();
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ watchDir: dir }, null, 2));
    this.startWatcher(dir);
  }

  getStatus(): LpReleaseStatus {
    const cfg    = this.readConfig();
    const status = this.readStatus();
    return {
      watchDir:    cfg?.watchDir    ?? null,
      version:     status?.version  ?? null,
      dmgFilename: status?.dmgFilename ?? null,
      lastUpdated: status?.lastUpdated ?? null,
    };
  }

  getCurrentDir() { return CURRENT_DIR; }

  // ── Private ────────────────────────────────────────────────────────────────

  private startWatcher(dir: string) {
    if (!fs.existsSync(dir)) {
      console.warn(`[LpReleaseService] watch dir does not exist: ${dir}`);
      return;
    }
    this.watchDir = dir;
    this.watcher = fs.watch(dir, (event, filename) => {
      if (filename !== 'latest-mac.yml') return;
      if (this.debounce) clearTimeout(this.debounce);
      // Debounce: electron-builder writes yml last, but give it 500 ms to finish.
      this.debounce = setTimeout(() => { void this.pickUpRelease(); }, 500);
    });
    this.watcher.on('error', (err) => {
      console.error('[LpReleaseService] watcher error:', err);
    });
  }

  private async pickUpRelease() {
    if (!this.watchDir) return;
    const ymlSrc = path.join(this.watchDir, 'latest-mac.yml');
    if (!fs.existsSync(ymlSrc)) return;

    let ymlText: string;
    try { ymlText = fs.readFileSync(ymlSrc, 'utf8'); }
    catch { return; }

    const version     = this.parseYmlField(ymlText, 'version');
    const dmgFilename = this.parseYmlField(ymlText, 'path');
    if (!version || !dmgFilename) {
      console.warn('[LpReleaseService] could not parse version/path from latest-mac.yml');
      return;
    }

    const dmgSrc = path.join(this.watchDir, dmgFilename);
    if (!fs.existsSync(dmgSrc)) {
      console.warn(`[LpReleaseService] dmg not found: ${dmgSrc}`);
      return;
    }

    // Remove old dmg(s) before copying the new one
    for (const f of fs.readdirSync(CURRENT_DIR)) {
      if (f.endsWith('.dmg')) fs.rmSync(path.join(CURRENT_DIR, f), { force: true });
    }

    fs.copyFileSync(ymlSrc, path.join(CURRENT_DIR, 'latest-mac.yml'));
    fs.copyFileSync(dmgSrc, path.join(CURRENT_DIR, dmgFilename));

    const lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATUS_PATH, JSON.stringify({ version, dmgFilename, lastUpdated }, null, 2));

    console.log(`[LpReleaseService] picked up LP v${version} (${dmgFilename})`);
    this.io.emit('lp-release:updated', { version, dmgFilename, lastUpdated });
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
