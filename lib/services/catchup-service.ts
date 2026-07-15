/**
 * Daily Catch-Up service — assembles the org-wide "what moved yesterday" recap.
 *
 * Two layers:
 *   1. Deterministic recap (pure SQL) — grouped Uploads/Media/Tasks/Jobs sections
 *      built from activity_events plus the two comment tables (media_comments,
 *      task_comments) that never reach activity_events. This never touches Claude.
 *   2. AI headline — one cached 1-sentence summary per day, gated by the
 *      catchup.ai_enabled setting. If disabled, unavailable, or erroring, the
 *      deterministic recap is returned unchanged with headline: null.
 *
 * The whole payload for a *past* day is static, so it's cached once per date in
 * catchup_cache — the headline is generated exactly once and every subsequent
 * open reads the cached row. See docs/project history.md (2026-07-14).
 *
 * Classification note: activity_events records a multi-phase pipeline per asset
 * (frameio.upload → ingest → transcription), so a single new clip emits several
 * "completed" rows across those families. Surfacing all of them would triple-
 * count every clip and drown the recap in machine churn. `classify()` therefore
 * collapses routine successful plumbing to a single user-meaningful event
 * (asset.registered = "a clip arrived") and drops the rest — while ALWAYS
 * keeping failures, which are the whole point of a morning catch-up.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getActivityDb, getCatchupCache, setCatchupCache } from '@/lib/store/activity-db';
import { getCoreDb } from '@/lib/store/core-db';
import { getSetting, SETTING_KEYS, SETTING_DEFAULTS } from '@/lib/store/lpos-settings-store';
import {
  CATCHUP_SECTION_ORDER,
  CATCHUP_ITEMS_PER_SECTION,
  type CatchupPayload,
  type CatchupRow,
  type CatchupSection,
  type CatchupSectionKey,
  type CatchupBadge,
} from '@/lib/models/catchup';

// Intermediate pipeline phases are noise for a human recap — a single asset can
// emit queued→started→completed. We keep only terminal / discrete phases at the
// SQL layer; classify() then decides which of those are worth surfacing.
const INTERMEDIATE_PHASES = ['queued', 'running', 'started', 'in_progress', 'pending'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Previous calendar day in server-local (Eastern) time, as YYYY-MM-DD. */
export function defaultCatchupDate(): string {
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
}

export function isValidCatchupDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T00:00:00`).getTime());
}

function dayWindow(date: string): { startIso: string; endIso: string; label: string } {
  // A date-time string with no zone parses as LOCAL time, so this is the
  // Eastern-midnight boundary; toISOString() gives the matching UTC bounds to
  // compare against the ISO-UTC timestamps stored in the DB.
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const label = start.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  return { startIso: start.toISOString(), endIso: end.toISOString(), label };
}

type Classified = { section: CatchupSectionKey; badge: CatchupBadge } | null;

/**
 * Map a raw activity event to a section + badge, or null to drop it.
 * Failures always surface (routed to a section by family); successful pipeline
 * plumbing (frameio.upload.completed, ingest.completed, transcription.completed,
 * lpai.* successes, …) is dropped in favour of the single discrete event that
 * represents the same work to a human.
 */
function classify(eventType: string, phase: string): Classified {
  const failed = phase === 'failed' || eventType.endsWith('.failed');
  if (failed) {
    const badge: CatchupBadge = { label: 'Failed', tone: 'failed' };
    if (eventType.startsWith('task.')) return { section: 'tasks', badge };
    if (eventType.startsWith('asset.')) return { section: 'media', badge };
    return { section: 'jobs', badge }; // uploads / ingest / transcription / publish / lpai failures
  }

  switch (eventType) {
    case 'asset.registered': return { section: 'uploads', badge: { label: 'Uploaded', tone: 'neutral' } };
    case 'script.uploaded':  return { section: 'uploads', badge: { label: 'Script', tone: 'neutral' } };
    case 'photo.uploaded':   return { section: 'uploads', badge: { label: 'Photos', tone: 'neutral' } };

    case 'asset.moved':            return { section: 'media', badge: { label: 'Moved', tone: 'neutral' } };
    case 'asset.deleted':          return { section: 'media', badge: { label: 'Removed', tone: 'neutral' } };
    case 'asset.metadata.updated': return { section: 'media', badge: { label: 'Updated', tone: 'neutral' } };
    case 'project.created':        return { section: 'media', badge: { label: 'New project', tone: 'neutral' } };
    case 'project.updated':        return { section: 'media', badge: { label: 'Updated', tone: 'neutral' } };
    case 'project.deleted':        return { section: 'media', badge: { label: 'Removed', tone: 'neutral' } };
    case 'delivery.created':       return { section: 'media', badge: { label: 'Delivered', tone: 'neutral' } };

    case 'leaderpass.publish.completed':  return { section: 'jobs', badge: { label: 'Published', tone: 'completed' } };
    case 'leaderpass.publish.cancelled':  return { section: 'jobs', badge: { label: 'Cancelled', tone: 'neutral' } };

    case 'task.created':        return { section: 'tasks', badge: { label: 'New', tone: 'neutral' } };
    case 'task.updated':        return { section: 'tasks', badge: { label: 'Updated', tone: 'neutral' } };
    case 'task.status.changed': return { section: 'tasks', badge: { label: 'Updated', tone: 'neutral' } };

    default: return null; // routine pipeline success plumbing — represented elsewhere, dropped here
  }
}

function snippet(body: string, max = 80): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Sort order within a section: failures first, then comments, then the rest by recency.
const TONE_PRIORITY: Record<string, number> = { failed: 0, comment: 1, completed: 2, neutral: 2 };

interface ActivityRowRaw {
  event_id: string;
  occurred_at: string;
  event_type: string;
  lifecycle_phase: string;
  title: string;
  project_id: string | null;
  asset_id: string | null;
  actor_type: string | null;
  actor_display: string | null;
}

// Which actor kinds name a *person* worth surfacing in a human recap. System /
// service / external_system activity is machine plumbing — there is no one to
// credit, so we leave the actor null rather than printing "system".
const PERSON_ACTOR_TYPES = new Set(['user', 'external_user', 'agent']);

/** Reduce a display name to just the first name for a friendlier, less formal
 * recap ("Jordan Johnson" → "Jordan"). Falls back to the email local-part for
 * external commenters stored only as an address, and returns the original for
 * anything without a clear split. */
function firstName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const base = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  const first = base.split(/\s+/)[0];
  return first || trimmed;
}

function personActor(type: string | null, display: string | null): string | null {
  if (!type || !PERSON_ACTOR_TYPES.has(type)) return null;
  const name = display?.trim();
  return name ? firstName(name) : null;
}

interface SectionBreakdown {
  key: CatchupSectionKey;
  label: string;
  total: number;
  badges: Array<{ label: string; count: number }>;
  people: Array<{ name: string; count: number }>; // who drove this section, most-active first
  projects: Array<{ name: string; count: number }>; // which projects this activity landed in, busiest first
  sample: string[]; // a few "Title — by Person (Project)" strings for the AI digest
}

interface DeterministicRecap {
  label: string;
  totals: { failures: number; comments: number; updates: number };
  sections: CatchupSection[];
  breakdown: SectionBreakdown[];
}

// Plain-English meaning of each section, handed to the AI so it never conflates
// (e.g. reads 47 uploads as "47 tasks completed").
const SECTION_MEANING: Record<CatchupSectionKey, string> = {
  uploads: 'new media assets that were uploaded',
  media: 'changes to media and comments left on video assets',
  tasks: 'task-dashboard activity (new tasks, status changes, notes) — this is task activity, NOT video comments, and these are not "completed tasks" unless a status change says so',
  jobs: 'render / transcription / publish job outcomes',
};

function buildDeterministic(date: string): DeterministicRecap {
  const { startIso, endIso, label } = dayWindow(date);
  const activityDb = getActivityDb();
  const coreDb = getCoreDb();

  const activityRows = activityDb
    .prepare(
      `SELECT event_id, occurred_at, event_type, lifecycle_phase, title, project_id, asset_id,
              actor_type, actor_display
       FROM activity_events
       WHERE visibility = 'user_timeline'
         AND occurred_at >= ? AND occurred_at < ?
         AND lifecycle_phase NOT IN (${INTERMEDIATE_PHASES.map(() => '?').join(',')})
       ORDER BY occurred_at DESC`,
    )
    .all(startIso, endIso, ...INTERMEDIATE_PHASES) as ActivityRowRaw[];

  const mediaComments = coreDb
    .prepare(
      `SELECT comment_id, project_id, asset_id, body, created_at,
              author_user_id, author_external_name, author_external_email
       FROM media_comments
       WHERE deleted_at IS NULL
         AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`,
    )
    .all(startIso, endIso) as Array<{
      comment_id: string; project_id: string; asset_id: string; body: string; created_at: string;
      author_user_id: string | null; author_external_name: string | null; author_external_email: string | null;
    }>;

  const taskComments = coreDb
    .prepare(
      `SELECT c.comment_id, c.created_at, c.body, c.task_id, c.author_id, t.description, t.client_name
       FROM task_comments c
       JOIN tasks t ON t.task_id = c.task_id
       WHERE c.kind = 'comment'
         AND c.created_at >= ? AND c.created_at < ?
       ORDER BY c.created_at DESC`,
    )
    .all(startIso, endIso) as Array<{
      comment_id: string; created_at: string; body: string; author_id: string;
      task_id: string; description: string; client_name: string;
    }>;

  // Resolve project names for everything that carries a project_id.
  const projectIds = new Set<string>();
  for (const r of activityRows) if (r.project_id) projectIds.add(r.project_id);
  for (const c of mediaComments) if (c.project_id) projectIds.add(c.project_id);
  const projectName = new Map<string, string>();
  if (projectIds.size > 0) {
    const ids = [...projectIds];
    const nameRows = coreDb
      .prepare(`SELECT project_id, name FROM projects WHERE project_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ project_id: string; name: string }>;
    for (const row of nameRows) projectName.set(row.project_id, row.name);
  }

  // Comments store the author as an internal user id (media & task comments) —
  // resolve those to display names so the recap can credit people by name.
  const userIds = new Set<string>();
  for (const c of mediaComments) if (c.author_user_id) userIds.add(c.author_user_id);
  for (const c of taskComments) if (c.author_id) userIds.add(c.author_id);
  const userName = new Map<string, string>();
  if (userIds.size > 0) {
    const ids = [...userIds];
    const nameRows = coreDb
      .prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string; name: string }>;
    for (const row of nameRows) userName.set(row.id, row.name);
  }

  const bySection = new Map<CatchupSectionKey, CatchupRow[]>();
  const push = (key: CatchupSectionKey, row: CatchupRow) => {
    const arr = bySection.get(key) ?? [];
    arr.push(row);
    bySection.set(key, arr);
  };

  for (const r of activityRows) {
    const c = classify(r.event_type, r.lifecycle_phase);
    if (!c) continue;

    const project = r.project_id ? projectName.get(r.project_id) ?? null : null;
    let href: string | null = null;
    if (c.section === 'tasks') {
      href = '/dashboard';
    } else if (r.project_id && r.asset_id) {
      href = `/projects/${r.project_id}?assetId=${r.asset_id}`;
    } else if (r.project_id) {
      href = `/projects/${r.project_id}`;
    }

    const actor = personActor(r.actor_type, r.actor_display);
    push(c.section, { id: r.event_id, title: r.title, project, actor, badge: c.badge, time: r.occurred_at, href });
  }

  for (const c of mediaComments) {
    const project = projectName.get(c.project_id) ?? null;
    // Internal LPOS commenter → resolved name; external Frame.io reviewer →
    // their stored name, falling back to email. `||` (not `??`) so an empty
    // stored name/email collapses to null rather than a blank actor.
    const external = c.author_external_name?.trim() || c.author_external_email?.trim() || null;
    const resolved = (c.author_user_id ? userName.get(c.author_user_id) : null) ?? external;
    const actor = resolved ? firstName(resolved) : null;
    push('media', {
      id: c.comment_id,
      title: snippet(c.body),
      project,
      actor,
      badge: { label: 'Comment', tone: 'comment' },
      time: c.created_at,
      href: `/projects/${c.project_id}?assetId=${c.asset_id}`,
    });
  }

  for (const c of taskComments) {
    // "Comment" is reserved for feedback on video assets (media_comments). A
    // note left on a task is task activity, not a media comment — badge it
    // "Note" (neutral) so it doesn't read as footage feedback and doesn't
    // inflate the header "comments" count, which counts media comments only.
    const resolved = c.author_id ? userName.get(c.author_id) : null;
    push('tasks', {
      id: c.comment_id,
      title: c.description,
      project: c.client_name || null,
      actor: resolved ? firstName(resolved) : null,
      badge: { label: 'Note', tone: 'neutral' },
      time: c.created_at,
      href: `/dashboard?task=${c.task_id}`,
    });
  }

  // Totals partition every surfaced item into failures / comments / updates.
  // "updates" is a neutral catch-all for all other activity (uploads, moves,
  // task activity, publishes) — deliberately NOT "completed", which would imply
  // finished tasks. The three header numbers always sum to the total shown.
  const totals = { failures: 0, comments: 0, updates: 0 };
  const sections: CatchupSection[] = [];
  const breakdown: SectionBreakdown[] = [];
  for (const { key, label: sectionLabel } of CATCHUP_SECTION_ORDER) {
    const rows = bySection.get(key);
    if (!rows || rows.length === 0) continue;

    const hist = new Map<string, number>();
    const peopleHist = new Map<string, number>();
    const projectHist = new Map<string, number>();
    for (const row of rows) {
      if (row.badge.tone === 'failed') totals.failures += 1;
      else if (row.badge.tone === 'comment') totals.comments += 1;
      else totals.updates += 1;
      hist.set(row.badge.label, (hist.get(row.badge.label) ?? 0) + 1);
      if (row.actor) peopleHist.set(row.actor, (peopleHist.get(row.actor) ?? 0) + 1);
      if (row.project) projectHist.set(row.project, (projectHist.get(row.project) ?? 0) + 1);
    }

    rows.sort((a, b) => {
      const pa = TONE_PRIORITY[a.badge.tone] ?? 2;
      const pb = TONE_PRIORITY[b.badge.tone] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
    });

    sections.push({
      key,
      label: sectionLabel,
      count: rows.length,
      items: rows.slice(0, CATCHUP_ITEMS_PER_SECTION),
      hasMore: rows.length > CATCHUP_ITEMS_PER_SECTION,
    });
    breakdown.push({
      key,
      label: sectionLabel,
      total: rows.length,
      badges: [...hist.entries()].map(([label, count]) => ({ label, count })),
      people: [...peopleHist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => ({ name, count })),
      projects: [...projectHist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count })),
      sample: rows.slice(0, 3).map(
        (r) => `${r.title}${r.actor ? ` — by ${r.actor}` : ''}${r.project ? ` (${r.project})` : ''}`,
      ),
    });
  }

  return { label, totals, sections, breakdown };
}

function buildDigest(recap: DeterministicRecap): string {
  const lines = [`Studio activity for ${recap.label}.`];

  lines.push(
    recap.totals.failures > 0
      ? `Failures needing attention: ${recap.totals.failures}.`
      : 'Failures needing attention: none.',
  );
  lines.push(
    recap.totals.comments > 0
      ? `Comments left on video assets: ${recap.totals.comments}.`
      : 'Comments left on video assets: none.',
  );

  lines.push('', 'Activity by category (only what is listed happened; do not invent totals):');
  if (recap.breakdown.length === 0) {
    lines.push('  (no activity)');
  }
  for (const b of recap.breakdown) {
    const badges = b.badges.map((x) => `${x.count} ${x.label}`).join(', ');
    // Which project(s) this activity landed in — at least as important as the
    // count. "N of TOTAL" keeps each project's share honest.
    const projects = b.projects.length > 0
      ? ` In project(s): ${b.projects.map((p) => `${p.name} (${p.count} of ${b.total})`).join(', ')}.`
      : '';
    // "N of TOTAL" makes each person's own share explicit so the summary can't
    // credit one person with the whole category (many rows have no named actor).
    const people = b.people.length > 0
      ? ` Contributors: ${b.people.map((p) => `${p.name} (${p.count} of ${b.total})`).join(', ')}.`
      : '';
    lines.push(`  ${b.label} — ${b.total} ${SECTION_MEANING[b.key]}. Breakdown: ${badges}.${projects}${people} e.g. ${b.sample.join('; ')}`);
  }
  return lines.join('\n');
}

/** Generate the AI headline. Returns null when disabled/unconfigured; throws on API error. */
async function generateHeadline(recap: DeterministicRecap): Promise<string | null> {
  const apiKey = process.env.CLAUDE_API_KEY?.trim();
  if (!apiKey) return null;
  const model = getSetting<string>(
    SETTING_KEYS.CATCHUP_HEADLINE_MODEL,
    SETTING_DEFAULTS[SETTING_KEYS.CATCHUP_HEADLINE_MODEL],
  );

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 250,
    system:
      "You write a one or two sentence, plain-English recap of what happened across a video-production studio's operating system yesterday, for the team's morning catch-up. " +
      'Rules: Report ONLY what the digest states — never invent or add up numbers into a new total. ' +
      "Use each category's stated meaning exactly. In this studio, a \"comment\" means feedback left on a video asset — only call something a comment if it is under \"Comments left on video assets\". " +
      'The word "task" refers only to the task-dashboard category; do NOT describe uploads, media, or job activity as tasks. ' +
      'Only say something was "completed" or "done" if the breakdown explicitly marks it Completed/Published; uploads and task activity are not completions. ' +
      'Be factual and specific: name the busiest category and call out any failures as needing attention. ' +
      'Lead with WHERE the work is happening — always name the specific project(s) each category landed in, using the "In project(s)" list. Which project(s) the activity is in is as important as the counts, so make projects central to the recap, not an afterthought. ' +
      'Each project is written "Project (N of TOTAL)": N is that project\'s share and TOTAL is the whole category — if activity spans several projects, name the top ones rather than implying it was all one project. ' +
      'Make it personal — credit the PEOPLE behind the work by name using the "Contributors" listed for each category (e.g. who drove uploads or left key comments). ' +
      'Each contributor is written "Name (N of TOTAL)": N is that person\'s OWN count and TOTAL is the whole category — many items have no named person, so NEVER credit a category\'s full total to one person; use their own N, and if their N is less than the total, phrase it as a contribution (e.g. "led by", "including", "N of them from"). ' +
      'Only name people the digest actually lists; never invent names, and if a category has no Contributors line, describe it without a name. ' +
      'No greeting, no preamble, no bullet points, no markdown — just the recap sentence(s).',
    messages: [{ role: 'user', content: `Summarize yesterday from this digest:\n${buildDigest(recap)}` }],
  });

  const block = message.content[0];
  if (block && block.type === 'text') {
    const text = block.text.trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Build (or read from cache) the full catch-up payload for a day.
 * Pass `refresh: true` to bypass the cache and regenerate.
 */
export async function buildCatchup(
  date: string,
  opts?: { refresh?: boolean },
): Promise<CatchupPayload> {
  if (!opts?.refresh) {
    const cached = getCatchupCache(date);
    if (cached) {
      try {
        return JSON.parse(cached) as CatchupPayload;
      } catch {
        // Corrupt cache row — fall through and regenerate.
      }
    }
  }

  const recap = buildDeterministic(date);
  const aiEnabled = getSetting<boolean>(
    SETTING_KEYS.CATCHUP_AI_ENABLED,
    SETTING_DEFAULTS[SETTING_KEYS.CATCHUP_AI_ENABLED],
  );

  let headline: string | null = null;
  let cacheable = true;
  if (aiEnabled) {
    try {
      headline = await generateHeadline(recap);
    } catch (err) {
      // Transient API failure — return the deterministic recap now, but don't
      // cache a null headline so the next open retries generation.
      console.error('[catchup] headline generation failed:', err);
      cacheable = false;
    }
  }

  const payload: CatchupPayload = {
    date,
    label: recap.label,
    headline,
    totals: recap.totals,
    sections: recap.sections,
    generatedAt: new Date().toISOString(),
  };

  if (cacheable) setCatchupCache(date, JSON.stringify(payload));
  return payload;
}
