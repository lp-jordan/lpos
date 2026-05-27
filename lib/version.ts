/**
 * App version — read from git at server start, cached for the process lifetime.
 *
 * The displayed string is `v.<commit-count> · <short-sha>`. Commit count is
 * monotonic (auto-advances every commit, and therefore every push), and the
 * SHA makes it trivial to `git checkout <sha>` if we ever need to recover
 * lost code from the exact build a user was on.
 *
 * Reads happen once at module load via `execSync`. A subsequent server
 * restart picks up new commits; we never re-shell-out per request.
 */
import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import path from 'node:path';

export interface AppVersion {
  /** Monotonic commit count on HEAD, e.g. 487. 0 if git is unavailable. */
  count: number;
  /** Full 40-char SHA, or 'unknown'. */
  sha: string;
  /** 7-char short SHA — what we render in the UI. */
  shaShort: string;
  /** Branch name, or 'detached' if HEAD is detached, or 'unknown'. */
  branch: string;
  /** Whether the working tree had uncommitted changes at server start. */
  dirty: boolean;
  /** ISO date of the HEAD commit, or '' if unavailable. */
  date: string;
  /** Pre-formatted display string, e.g. "v.487 · a1b2c3d". */
  display: string;
}

function readGit(): AppVersion {
  // Resolve repo root from this file's location so dev/prod cwd quirks don't
  // matter. lib/version.ts → repo root is one level up.
  const cwd = path.resolve(__dirname, '..');
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    encoding: 'utf8',
    // swallow stderr so "not a git repo" errors don't spam the console
    stdio: ['ignore', 'pipe', 'ignore'],
  };

  try {
    const count    = parseInt(execSync('git rev-list --count HEAD', opts).trim(), 10);
    const sha      = execSync('git rev-parse HEAD', opts).trim();
    const shaShort = sha.slice(0, 7);
    let branch     = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    if (branch === 'HEAD') branch = 'detached';
    const date     = execSync('git log -1 --format=%cI HEAD', opts).trim();
    let dirty = false;
    try {
      dirty = execSync('git status --porcelain', opts).trim().length > 0;
    } catch {
      // status can fail in a freshly-shipped tree; treat as clean.
    }
    return {
      count: Number.isFinite(count) ? count : 0,
      sha,
      shaShort,
      branch,
      dirty,
      date,
      display: `v.${count}${dirty ? '*' : ''} · ${shaShort}`,
    };
  } catch {
    return {
      count: 0,
      sha: 'unknown',
      shaShort: 'unknown',
      branch: 'unknown',
      dirty: false,
      date: '',
      display: 'v.dev',
    };
  }
}

let cached: AppVersion | null = null;

export function getAppVersion(): AppVersion {
  if (cached) return cached;
  cached = readGit();
  return cached;
}
