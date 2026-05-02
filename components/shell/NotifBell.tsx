'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/contexts/ToastContext';
import { useTaskNotifications } from '@/hooks/useTaskNotifications';
import { useProspectNotifications } from '@/hooks/useProspectNotifications';
import type { NotificationRecord } from '@/contexts/ToastContext';
import type { TaskNotification, TaskNotifType } from '@/lib/models/task-notification';
import type { ProspectNotification, ProspectNotifType } from '@/lib/models/prospect-notification';

function buildNotifHref(notif: Pick<NotificationRecord, 'projectId' | 'assetId'>): string | null {
  if (!notif.projectId) return null;
  if (!notif.assetId) return `/projects/${notif.projectId}`;
  const params = new URLSearchParams({ assetId: notif.assetId });
  return `/projects/${notif.projectId}?${params.toString()}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TASK_NOTIF_LABEL: Record<TaskNotifType, string> = {
  assigned: 'Assigned to you',
  mentioned: 'Mentioned you',
  status_changed: 'Status changed',
  commented: 'New comment',
};

const PROSPECT_NOTIF_LABEL: Record<ProspectNotifType, string> = {
  assigned:       'Assigned to prospect',
  update_posted:  'New prospect update',
  mentioned:      'Mentioned in prospect',
  status_changed: 'Prospect status changed',
  promoted:       'Prospect promoted',
};

function ProspectNotifItem({ notif, onClick }: { notif: ProspectNotification; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`notif-item notif-task-item${notif.read ? ' notif-task-item--read' : ' notif-task-item--unread'}`}
      onClick={onClick}
      role="menuitem"
    >
      <div className="notif-task-type">{PROSPECT_NOTIF_LABEL[notif.type]}</div>
      <div className="notif-task-title">{notif.company}</div>
      {notif.fromName && (
        <div className="notif-task-from">by {notif.fromName}</div>
      )}
      <div className="notif-task-time">{relativeTime(notif.createdAt)}</div>
    </button>
  );
}

function TaskNotifItem({ notif, onClick }: { notif: TaskNotification; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`notif-item notif-task-item${notif.read ? ' notif-task-item--read' : ' notif-task-item--unread'}`}
      onClick={onClick}
      role="menuitem"
    >
      <div className="notif-task-type">{TASK_NOTIF_LABEL[notif.type]}</div>
      <div className="notif-task-title">{notif.taskTitle}</div>
      {notif.fromName && (
        <div className="notif-task-from">by {notif.fromName}</div>
      )}
      <div className="notif-task-time">{relativeTime(notif.createdAt)}</div>
    </button>
  );
}

export function NotifBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { notifications: pipelineNotifs, unreadCount: pipelineUnread, markAllRead: markPipelineRead } = useToast();
  const { notifications: taskNotifs,     unreadCount: taskUnread,     markAllRead: markTasksRead     } = useTaskNotifications();
  const { notifications: prospectNotifs, unreadCount: prospectUnread, markAllRead: markProspectsRead } = useProspectNotifications();

  const totalUnread = pipelineUnread + taskUnread + prospectUnread;

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  function toggle() {
    const opening = !open;
    setOpen(opening);
    if (opening) {
      markPipelineRead();
      markTasksRead();
      markProspectsRead();
    }
  }

  const hasAny = pipelineNotifs.length > 0 || taskNotifs.length > 0 || prospectNotifs.length > 0;

  return (
    <div className="notif-bell" ref={rootRef}>
      <button
        type="button"
        className="notif-bell-trigger"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={totalUnread > 0 ? `${totalUnread} unread notification${totalUnread !== 1 ? 's' : ''}` : 'Notifications'}
        data-guest-ok
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {totalUnread > 0 && (
          <span className="notif-bell-badge" aria-hidden="true">
            {totalUnread > 9 ? '9+' : totalUnread}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-panel" role="menu" aria-label="Notifications">
          <div className="notif-panel-header">Notifications</div>
          <div className="notif-panel-list">
            {!hasAny && (
              <div className="notif-empty">No notifications yet</div>
            )}

            {taskNotifs.length > 0 && (
              <>
                <div className="notif-section-label">Tasks</div>
                {taskNotifs.slice(0, 10).map((notif) => (
                  <TaskNotifItem
                    key={notif.notifId}
                    notif={notif}
                    onClick={() => {
                      router.push(`/dashboard?task=${notif.taskId}`);
                      setOpen(false);
                    }}
                  />
                ))}
              </>
            )}

            {prospectNotifs.length > 0 && (
              <>
                <div className="notif-section-label">Prospects</div>
                {prospectNotifs.slice(0, 10).map((notif) => (
                  <ProspectNotifItem
                    key={notif.notifId}
                    notif={notif}
                    onClick={() => {
                      router.push(`/prospects/${notif.prospectId}`);
                      setOpen(false);
                    }}
                  />
                ))}
              </>
            )}

            {pipelineNotifs.length > 0 && (
              <>
                <div className="notif-section-label">Pipeline</div>
                {pipelineNotifs.map((notif) => {
                  const href = buildNotifHref(notif);
                  return (
                    <button
                      key={notif.id}
                      type="button"
                      className={`notif-item notif-item--${notif.tone}${href ? ' notif-item--clickable' : ''}`}
                      onClick={() => {
                        if (href) router.push(href);
                        setOpen(false);
                      }}
                      disabled={!href}
                      role="menuitem"
                    >
                      <span className="notif-item-title">{notif.title}</span>
                      <span className="notif-item-body">{notif.body}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
