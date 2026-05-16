'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { ActivityHistoryModal } from './ActivityHistoryModal';
import {
  DEFAULT_ACTIVITY_BUCKET,
  eventTypeToBucket,
  type ActivityBucket,
} from '@/lib/models/activity-bucket';

/**
 * Org-wide recent-activity strip rendered in the dashboard header. Shows the 6
 * most recent user_timeline events horizontally, right-justified. Click anywhere
 * on the strip to open the full filterable history modal.
 *
 * Live updates: the strip listens on the global Socket.io namespace for
 * `activity:recorded` and prepends matching events (visibility = 'user_timeline')
 * to its local list, trimming back to STRIP_LIMIT.
 *
 * Strip default = tasks bucket. The modal exposes the other buckets via tabs;
 * the strip itself is intentionally narrow on this view to keep the dashboard
 * header focused on task activity (the most actionable feed).
 *
 * Same content shown to every signed-in user — this is intentional. The
 * /api/dashboard/activity endpoint (sidebar feed) is the per-user-scoped view;
 * this strip is the org-wide pulse.
 */

const STRIP_LIMIT = 6;
const STRIP_BUCKET: ActivityBucket = DEFAULT_ACTIVITY_BUCKET; // 'tasks'

export interface ActivityStripEvent {
  event_id: string;
  occurred_at: string;
  event_type: string;
  lifecycle_phase: string;
  title: string;
  summary: string | null;
  project_id: string | null;
  client_id: string | null;
  actor_id: string | null;
  actor_display: string | null;
  actor_type: string | null;
  visibility?: string;
}

interface Props {
  projectMap: Map<string, string>;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function ActivityStrip({ projectMap }: Readonly<Props>) {
  const [events, setEvents] = useState<ActivityStripEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  // Re-render every minute so relativeTime() stays current for the visible chips
  // without us having to push fresh data through.
  const [, forceTick] = useState(0);

  // Initial fetch (tasks bucket only).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/activity/recent?limit=${STRIP_LIMIT}&bucket=${STRIP_BUCKET}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { activity: ActivityStripEvent[] };
        if (!cancelled) setEvents(data.activity);
      } catch {
        // Leave empty — strip just renders blank rather than erroring noisily.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Tick once a minute to refresh relative times.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // Socket subscription for live prepends. Activity broadcasts go out on the
  // global namespace (no prefix), unlike tasks which use /tasks.
  const socketRef = useRef<Socket | null>(null);
  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('activity:recorded', (event: ActivityStripEvent) => {
      // Server emits every recorded event regardless of visibility; filter here.
      if (event.visibility && event.visibility !== 'user_timeline') return;
      // Strip is bucket-scoped (tasks). Drop events that don't map.
      if (eventTypeToBucket(event.event_type) !== STRIP_BUCKET) return;
      setEvents((prev) => {
        if (prev.some((e) => e.event_id === event.event_id)) return prev;
        return [event, ...prev].slice(0, STRIP_LIMIT);
      });
    });
    return () => { socket.disconnect(); };
  }, []);

  const projectName = useCallback((id: string | null) => {
    if (!id) return null;
    return projectMap.get(id) ?? null;
  }, [projectMap]);

  const visibleEvents = useMemo(() => events.slice(0, STRIP_LIMIT), [events]);

  if (loading) {
    return (
      <button
        type="button"
        className="activity-strip activity-strip--loading"
        onClick={() => setModalOpen(true)}
        aria-label="Open activity history"
      >
        <span className="activity-strip-loading-dots">Loading activity…</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="activity-strip"
        onClick={() => setModalOpen(true)}
        aria-label="Open activity history"
        title="Click to view full activity history"
      >
        {visibleEvents.length === 0 ? (
          <span className="activity-strip-empty">No recent activity</span>
        ) : (
          <ol className="activity-strip-list">
            {visibleEvents.map((e) => {
              const proj = projectName(e.project_id);
              return (
                <li key={e.event_id} className="activity-strip-item">
                  <span className="activity-strip-time">{relativeTime(e.occurred_at)}</span>
                  <span className="activity-strip-title">{e.title}</span>
                  {proj && <span className="activity-strip-project">· {proj}</span>}
                </li>
              );
            })}
          </ol>
        )}
        <span className="activity-strip-more" aria-hidden="true">›</span>
      </button>

      {modalOpen && (
        <ActivityHistoryModal
          projectMap={projectMap}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}
