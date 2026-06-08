/**
 * App version — read from git + package.json at server start, cached for the
 * process lifetime.
 *
 * Scheme: **hybrid semver**. `major.minor` is read from `package.json.version`
 * (you bump it manually when something user-noticeable ships). `patch` is the
 * number of commits since the last commit that modified the version field in
 * `package.json` — auto-incrementing, so a build is always uniquely identifiable
 * even without manual bookkeeping.
 *
 * Display: `<major>.<minor>.<patch>[*] · <short-sha>`, e.g. `0.1.12 · a1b2c3d`.
 * (Asterisk if the working tree was dirty at server start.)
 *
 * When you bump `major.minor` in `package.json`, the patch resets to 0 at the
 * commit that changed it. The next commit gets patch = 1, and so on.
 *
 * Reads happen once at module load via `execSync`. A subsequent server restart
 * picks up new commits; we never re-shell-out per request.
 */
import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AppVersion {
  /** Total monotonic commit count on HEAD (kept for backwards compatibility / forensics). */
  count: number;
  /** Major component from package.json.version. */
  major: number;
  /** Minor component from package.json.version. */
  minor: number;
  /** Auto-computed patch: commits since the last bump of package.json.version. */
  patch: number;
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
  /** Pre-formatted display string, e.g. "0.1.12 · a1b2c3d". */
  display: string;
}

/** Read package.json.version → [major, minor]. Falls back to [0,0] if absent
 *  or unparseable. We deliberately ignore the patch from package.json — patch
 *  is auto-computed from git history below. */
function readPackageMajorMinor(repoRoot: string): { major: number; minor: number } {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    const parts = (pkg.version ?? '0.0.0').split('.');
    const major = parseInt(parts[0] ?? '0', 10);
    const minor = parseInt(parts[1] ?? '0', 10);
    return {
      major: Number.isFinite(major) ? major : 0,
      minor: Number.isFinite(minor) ? minor : 0,
    };
  } catch {
    return { major: 0, minor: 0 };
  }
}

/** Count commits since the last commit that changed the `"version":` line in
 *  package.json. `-G` matches changes whose patch contains the regex, so
 *  unrelated package.json edits (deps, scripts, etc.) don't reset the patch.
 *  Returns the total commit count as a fallback when no version-touching
 *  commit is reachable from HEAD. */
function computePatch(opts: ExecSyncOptionsWithStringEncoding): number {
  try {
    const anchorSha = execSync(
      'git log -1 --format=%H -G \'^[ \\t]*"version":\' -- package.json',
      opts,
    ).trim();
    if (!anchorSha) {
      // No version-bump commit found in history — patch is just total count.
      const total = parseInt(execSync('git rev-list --count HEAD', opts).trim(), 10);
      return Number.isFinite(total) ? total : 0;
    }
    // Count commits AFTER the anchor (exclusive). If anchor === HEAD, this
    // returns 0, which is exactly what we want for "just bumped, no commits
    // past it yet".
    const since = parseInt(
      execSync(`git rev-list --count ${anchorSha}..HEAD`, opts).trim(),
      10,
    );
    return Number.isFinite(since) ? since : 0;
  } catch {
    return 0;
  }
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

    const { major, minor } = readPackageMajorMinor(cwd);
    const patch = computePatch(opts);

    return {
      count: Number.isFinite(count) ? count : 0,
      major,
      minor,
      patch,
      sha,
      shaShort,
      branch,
      dirty,
      date,
      display: `${major}.${minor}.${patch}${dirty ? '*' : ''} · ${shaShort}`,
    };
  } catch {
    return {
      count: 0,
      major: 0,
      minor: 0,
      patch: 0,
      sha: 'unknown',
      shaShort: 'unknown',
      branch: 'unknown',
      dirty: false,
      date: '',
      display: 'dev',
    };
  }
}

let cached: AppVersion | null = null;

export function getAppVersion(): AppVersion {
  if (cached) return cached;
  cached = readGit();
  return cached;
}
