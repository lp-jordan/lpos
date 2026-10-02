'use client';

/**
 * Shared list controls — the A–Z / Recent sort toggle, card/list view toggle,
 * and the Recent-sort date buckets. Used by the Projects client list and the
 * Platform pass gallery so sorting looks and behaves the same everywhere.
 */

export type ViewMode = 'card' | 'list';
export type SortMode = 'alpha' | 'activity';
export type ActivityBucket = 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Earlier';

export const ACTIVITY_BUCKETS: ActivityBucket[] = ['Today', 'Yesterday', 'This Week', 'This Month', 'Earlier'];

export function getActivityBucket(iso: string | null | undefined): ActivityBucket {
  if (!iso) return 'Earlier';
  try {
    const ms = new Date(iso).getTime();
    if (isNaN(ms)) return 'Earlier';
    const days = Math.floor((Date.now() - ms) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7)  return 'This Week';
    if (days < 30) return 'This Month';
    return 'Earlier';
  } catch { return 'Earlier'; }
}

// ── View toggle ───────────────────────────────────────────────────────────────

export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="m-view-toggle">
      <button className={`m-view-btn${mode === 'card' ? ' active' : ''}`} type="button" onClick={() => onChange('card')} aria-label="Card view">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
      </button>
      <button className={`m-view-btn${mode === 'list' ? ' active' : ''}`} type="button" onClick={() => onChange('list')} aria-label="List view">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </button>
    </div>
  );
}

// ── Sort toggle ───────────────────────────────────────────────────────────────

export function SortToggle({ mode, onChange }: { mode: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <div className="m-view-toggle">
      <button
        className={`m-view-btn m-view-btn--text${mode === 'alpha' ? ' active' : ''}`}
        type="button"
        onClick={() => onChange('alpha')}
        title="Sort alphabetically"
      >A–Z</button>
      <button
        className={`m-view-btn${mode === 'activity' ? ' active' : ''}`}
        type="button"
        onClick={() => onChange('activity')}
        title="Sort by recent activity"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
      </button>
    </div>
  );
}
