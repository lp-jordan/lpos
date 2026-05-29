/**
 * EpReleaseService
 *
 * Watches a local directory for new EditPanel builds produced by electron-builder
 * (on the Windows machine) and makes them available for download by editpanel
 * clients. Sibling of LpReleaseService — EditPanel ships a Windows installer, so
 * this watches `latest.yml` (the Windows manifest) and serves an `.exe`.
 *
 * Flow:
 *   1. Admin configures watchDir in LPOS settings (the NAS folder the Windows
 *      build writes to, e.g. /Volumes/LeaderPass Main/LPOS/editpanel dist).
 *   2. The Windows machine runs `npm run package` (writing to that NAS folder).
 *   3. electron-builder writes latest.yml + the .exe to watchDir.
 *   4. This service detects latest.yml, parses version + installer filename,
 *      copies both files into /data/ep-releases/current/.
 *   5. Emits `ep-release:updated` socket event so LPOS UI can refresh.
 *   6. editpanel clients / the /ep-update page see the new version and download it.
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

  private startWatcher(dir: string) {
    if (!fs.existsSync(dir)) {
      console.warn(`[EpReleaseService] watch dir does not exist: ${dir}`);
      return;
    }
    this.watchDir = dir;
    this.watcher = fs.watch(dir, (event, filename) => {
      if (filename !== 'latest.yml') return;
      if (this.debounce) clearTimeout(this.debounce);
      // Debounce: electron-builder writes yml last, but give it 500 ms to finish.
      this.debounce = setTimeout(() => { void this.pickUpRelease(); }, 500);
    });
    this.watcher.on('error', (err) => {
      console.error('[EpReleaseService] watcher error:', err);
    });
  }

  private async pickUpRelease() {
    if (!this.watchDir) return;
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

    const exeSrc = path.join(this.watchDir, installerFilename);
    if (!fs.existsSync(exeSrc)) {
      console.warn(`[EpReleaseService] installer not found: ${exeSrc}`);
      return;
    }

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
