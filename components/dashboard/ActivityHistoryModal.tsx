'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityStripEvent } from './ActivityStrip';
import {
  ACTIVITY_BUCKETS,
  DEFAULT_ACTIVITY_BUCKET,
  type ActivityBucket,
} from '@/lib/models/activity-bucket';

/**
 * Full activity history modal. Reads from /api/activity/recent with the same
 * org-wide visibility = 'user_timeline' contract as the strip. Supports:
 *
 *   - Free-text search (q) — matches title / summary / search_text
 *   - Event-type filter (single select; options derived from loaded data)
 *   - Project filter (single select)
 *   - Cursor pagination via `before` (most-recent timestamp from last batch)
 *
 * The first batch is 100 events. "Load more" appends another 100 using the
 * oldest event's timestamp as the cursor.
 */

const PAGE_SIZE = 100;

interface Props {
  projectMap: Map<string, string>;
  onClose: () => void;
}

function formatExact(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function readableEventType(eventType: string): string {
  // Replace dots/underscores with spaces and Title-Case roughly.
  return eventType
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ActivityHistoryModal({ projectMap, onClose }: Readonly<Props>) {
  const [events, setEvents] = useState<ActivityStripEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter state.
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [bucket, setBucket] = useState<ActivityBucket>(DEFAULT_ACTIVITY_BUCKET);
  const [projectIdFilter, setProjectIdFilter] = useState('');

  // Debounce free-text search so we don't fire a request on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Re-fetch from scratch whenever any filter changes.
  const fetchSeq = useRef(0);
  useEffect(() => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('bucket', bucket);
    if (qDebounced) params.set('q', qDebounced);
    if (projectIdFilter) params.set('projectId', projectIdFilter);

    (async () => {
      try {
        const res = await fetch(`/api/activity/recent?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { activity: ActivityStripEvent[]; hasMore: boolean };
        if (seq !== fetchSeq.current) return; // a newer fetch already superseded us
        setEvents(data.activity);
        setHasMore(data.hasMore);
      } catch (err) {
        if (seq !== fetchSeq.current) return;
        setError((err as Error).message);
      } finally {
        if (seq === fetchSeq.current) setLoading(false);
      }
    })();
  }, [qDebounced, bucket, projectIdFilter]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || events.length === 0) return;
    setLoadingMore(true);
    const oldest = events[events.length - 1]!.occurred_at;
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('before', oldest);
    params.set('bucket', bucket);
    if (qDebounced) params.set('q', qDebounced);
    if (projectIdFilter) params.set('projectId', projectIdFilter);
    try {
      const res = await fetch(`/api/activity/recent?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { activity: ActivityStripEvent[]; hasMore: boolean };
      setEvents((prev) => [...prev, ...data.activity]);
      setHasMore(data.hasMore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, events, bucket, qDebounced, projectIdFilter]);

  // Project options derived from loaded events so the user can filter to a
  // project they see in the list.
  const projectOptions = useMemo(() => {
    const set = new Map<string, string>();
    events.forEach((e) => {
      if (e.project_id) {
        const name = projectMap.get(e.project_id) ?? e.project_id.slice(0, 8);
        set.set(e.project_id, name);
      }
    });
    return Array.from(set.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [events, projectMap]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasActiveFilter = !!(qDebounced || projectIdFilter || bucket !== DEFAULT_ACTIVITY_BUCKET);

  return (
    <div className="activity-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="activity-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Activity history"
      >
        <header className="activity-modal-header">
          <h2 className="activity-modal-title">Activity History</h2>
          <button
            type="button"
            className="activity-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="activity-modal-bucket-tabs" role="tablist" aria-label="Activity category">
          {ACTIVITY_BUCKETS.map((b) => (
            <button
              key={b.value}
              type="button"
              role="tab"
              aria-selected={bucket === b.value}
              className={`activity-modal-bucket-tab${bucket === b.value ? ' activity-modal-bucket-tab--active' : ''}`}
              onClick={() => setBucket(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="activity-modal-filters">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title or summary…"
            className="activity-modal-search"
            aria-label="Search activity"
          />
          <select
            value={projectIdFilter}
            onChange={(e) => setProjectIdFilter(e.target.value)}
            className="activity-modal-select"
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {projectOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          {hasActiveFilter && (
            <button
              type="button"
              className="activity-modal-clear"
              onClick={() => {
                setQ('');
                setProjectIdFilter('');
                setBucket(DEFAULT_ACTIVITY_BUCKET);
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="activity-modal-body">
          {error && (
            <div className="activity-modal-error" role="alert">
              Failed to load activity: {error}
            </div>
          )}
          {loading ? (
            <div className="activity-modal-loading">Loading…</div>
          ) : events.length === 0 ? (
            <div className="activity-modal-empty">
              {hasActiveFilter ? 'No activity matches your filters.' : 'No activity recorded yet.'}
            </div>
          ) : (
            <ul className="activity-modal-list">
              {events.map((e) => {
                const proj = e.project_id ? projectMap.get(e.project_id) : null;
                const showActor = e.actor_display && e.actor_type !== 'system';
                return (
                  <li key={e.event_id} className="activity-modal-item">
                    <div className="activity-modal-item-main">
                      <span className="activity-modal-item-title">{e.title}</span>
                      {e.summary && (
                        <span className="activity-modal-item-summary">{e.summary}</span>
                      )}
                    </div>
                    <div className="activity-modal-item-meta">
                      {proj && <span className="activity-modal-item-project">{proj}</span>}
                      {showActor && <span className="activity-modal-item-actor">{e.actor_display}</span>}
                      <span className="activity-modal-item-type">{readableEventType(e.event_type)}</span>
                      <time className="activity-modal-item-time" dateTime={e.occurred_at}>
                        {formatExact(e.occurred_at)}
                      </time>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {!loading && hasMore && (
          <footer className="activity-modal-footer">
            <button
              type="button"
              className="activity-modal-load-more"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
