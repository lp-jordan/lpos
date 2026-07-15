/**
 * Daily Catch-Up — shared types for the org-wide "what moved yesterday" drawer.
 *
 * Pure types only (no server imports) so the client drawer component and the
 * server-side builder/route can both import from here without pulling the
 * SQLite layer into the browser bundle.
 *
 * See docs/project history.md (2026-07-14) for the design decisions:
 * org-wide scope, launcher-pill → right drawer, AI headline layered on top of
 * a fully-deterministic grouped recap.
 */

export type CatchupSectionKey = 'uploads' | 'media' | 'tasks' | 'jobs';

export type CatchupBadgeTone = 'failed' | 'completed' | 'comment' | 'neutral';

export interface CatchupBadge {
  label: string;
  tone: CatchupBadgeTone;
}

export interface CatchupRow {
  id: string;
  title: string;
  client: string | null; // the client the activity belongs to (recap groups by client, not project)
  actor: string | null; // who did it (person's display name); null for system/service activity
  badge: CatchupBadge;
  time: string; // ISO occurred/created timestamp
  href: string | null;
}

export interface CatchupSection {
  key: CatchupSectionKey;
  label: string;
  count: number; // total notable items for the day (shown + rolled-into-count)
  items: CatchupRow[]; // top-N, failures/comments first
  hasMore: boolean;
}

export interface CatchupTotals {
  failures: number;
  comments: number; // video-asset comments only (media_comments)
  updates: number; // all other activity (uploads, moves, task activity, publishes) — NOT "completed"
}

export interface CatchupPayload {
  date: string; // YYYY-MM-DD (server-local / Eastern)
  label: string; // "Friday, July 11, 2025"
  headline: string | null; // AI one-liner; null when disabled or unavailable
  totals: CatchupTotals;
  sections: CatchupSection[];
  generatedAt: string; // ISO
}

export const CATCHUP_SECTION_ORDER: Array<{ key: CatchupSectionKey; label: string }> = [
  { key: 'uploads', label: 'Uploads' },
  { key: 'media', label: 'Media' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'jobs', label: 'Jobs' },
];

/** How many rows to show per section before rolling the rest into the count badge. */
export const CATCHUP_ITEMS_PER_SECTION = 6;
