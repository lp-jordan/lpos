'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/contexts/ToastContext';
import { useTaskNotifications } from '@/hooks/useTaskNotifications';
import { useProspectNotifications } from '@/hooks/useProspectNotifications';
import { useDeliveryNotifications } from '@/hooks/useDeliveryNotifications';
import { useCommentNotifications } from '@/hooks/useCommentNotifications';
import type { NotificationRecord } from '@/contexts/ToastContext';
import type { TaskNotification, TaskNotifType } from '@/lib/models/task-notification';
import type { ProspectNotification, ProspectNotifType } from '@/lib/models/prospect-notification';
import type { DeliveryNotification } from '@/lib/models/delivery-notification';
import type { CommentNotification } from '@/lib/models/comment-notification';

type NotifTab = 'tasks' | 'prospects' | 'deliveries' | 'pipeline' | 'comments';

const TAB_STORAGE_KEY = 'lpos-notif-tab';

function getInitialTab(): NotifTab {
  if (typeof window === 'undefined') return 'tasks';
  const stored = localStorage.getItem(TAB_STORAGE_KEY);
  if (stored === 'tasks' || stored === 'prospects' || stored === 'deliveries' || stored === 'pipeline' || stored === 'comments') {
    return stored;
  }
  return 'tasks';
}

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
      className={`notif-task-item${notif.read ? ' notif-task-item--read' : ' notif-task-item--unread'}`}
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

function DeliveryNotifItem({ notif, onClick }: { notif: DeliveryNotification; onClick: () => void }) {
  const title = notif.clientName
    ? `${notif.projectName} — ${notif.clientName}`
    : notif.projectName;
  return (
    <button
      type="button"
      className={`notif-task-item${notif.read ? ' notif-task-item--read' : ' notif-task-item--unread'}`}
      onClick={onClick}
      role="menuitem"
    >
      <div className="notif-task-type">
        {notif.type === 'delivery_expired' ? 'Delivery link expired' : 'Delivery trouble report'}
      </div>
      <div className="notif-task-title">{title}</div>
      {notif.description && (
        <div className="notif-task-from">&ldquo;{notif.description}&rdquo;</div>
      )}
      {notif.queueSummary && (
        <div className="notif-task-from">{notif.queueSummary}</div>
      )}
      <div className="notif-task-time">{relativeTime(notif.createdAt)}</div>
    </button>
  );
}

function TaskNotifItem({ notif, onClick }: { notif: TaskNotification; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`notif-task-item${notif.read ? ' notif-task-item--read' : ' notif-task-item--unread'}`}
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

function CommentNotifItem({ notif, onClick }: { notif: CommentNotification; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`notif-task-item${notif.read ? ' notif-task-item--read' : ' notif-task-item--unread'}`}
      onClick={onClick}
      role="menuitem"
    >
      <div className="notif-task-type">Reply to your comment</div>
      <div className="notif-task-title">{notif.assetName}</div>
      {notif.snippet && (
        <div className="notif-task-from">&ldquo;{notif.snippet}&rdquo;</div>
      )}
      {notif.fromName && (
        <div className="notif-task-from">by {notif.fromName}</div>
      )}
      <div className="notif-task-time">{relativeTime(notif.createdAt)}</div>
    </button>
  );
}

const TAB_ORDER: NotifTab[] = ['pipeline', 'deliveries', 'tasks', 'comments', 'prospects'];
const TAB_LABEL: Record<NotifTab, string> = {
  pipeline: 'Pipeline',
  deliveries: 'Deliveries',
  tasks: 'Tasks',
  comments: 'Comments',
  prospects: 'People',
};

export function NotifBell() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<NotifTab>(getInitialTab);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { notifications: pipelineNotifs, unreadCount: pipelineUnread, markAllRead: markPipelineRead } = useToast();
  const { notifications: taskNotifs,     unreadCount: taskUnread,     markAllRead: markTasksRead     } = useTaskNotifications();
  const { notifications: prospectNotifs, unreadCount: prospectUnread, markAllRead: markProspectsRead } = useProspectNotifications();
  const { notifications: deliveryNotifs, unreadCount: deliveryUnread, markAllRead: markDeliveriesRead } = useDeliveryNotifications();
  const { notifications: commentNotifs,  unreadCount: commentUnread,  markAllRead: markCommentsRead   } = useCommentNotifications();

  const totalUnread = pipelineUnread + taskUnread + prospectUnread + deliveryUnread + commentUnread;

  const unreadByTab: Record<NotifTab, number> = {
    tasks: taskUnread,
    prospects: prospectUnread,
    deliveries: deliveryUnread,
    pipeline: pipelineUnread,
    comments: commentUnread,
  };

  function markTabRead(tab: NotifTab) {
    if (tab === 'tasks') markTasksRead();
    else if (tab === 'prospects') markProspectsRead();
    else if (tab === 'deliveries') markDeliveriesRead();
    else if (tab === 'comments') markCommentsRead();
    else markPipelineRead();
  }

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
      markTabRead(activeTab);
    }
  }

  function switchTab(tab: NotifTab) {
    setActiveTab(tab);
    localStorage.setItem(TAB_STORAGE_KEY, tab);
    markTabRead(tab);
  }

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
          <div className="notif-tabs" role="tablist">
            {TAB_ORDER.map((tab) => {
              const count = unreadByTab[tab];
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  className={`notif-tab${activeTab === tab ? ' notif-tab--active' : ''}`}
                  onClick={() => switchTab(tab)}
                >
                  {TAB_LABEL[tab]}
                  {count > 0 && (
                    <span className="notif-tab-badge">{count > 9 ? '9+' : count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="notif-panel-list" role="tabpanel">
            {activeTab === 'deliveries' && (
              deliveryNotifs.length === 0
                ? <div className="notif-empty">No delivery notifications</div>
                : deliveryNotifs.slice(0, 10).map((notif) => (
                    <DeliveryNotifItem
                      key={notif.notifId}
                      notif={notif}
                      onClick={() => {
                        if (notif.href) router.push(notif.href);
                        setOpen(false);
                      }}
                    />
                  ))
            )}

            {activeTab === 'tasks' && (
              taskNotifs.length === 0
                ? <div className="notif-empty">No task notifications</div>
                : taskNotifs.slice(0, 10).map((notif) => (
                    <TaskNotifItem
                      key={notif.notifId}
                      notif={notif}
                      onClick={() => {
                        router.push(`/dashboard?task=${notif.taskId}`);
                        setOpen(false);
                      }}
                    />
                  ))
            )}

            {activeTab === 'prospects' && (
              prospectNotifs.length === 0
                ? <div className="notif-empty">No prospect notifications</div>
                : prospectNotifs.slice(0, 10).map((notif) => (
                    <ProspectNotifItem
                      key={notif.notifId}
                      notif={notif}
                      onClick={() => {
                        router.push(`/prospects/${notif.prospectId}`);
                        setOpen(false);
                      }}
                    />
                  ))
            )}

            {activeTab === 'comments' && (
              commentNotifs.length === 0
                ? <div className="notif-empty">No comment notifications</div>
                : commentNotifs.slice(0, 10).map((notif) => (
                    <CommentNotifItem
                      key={notif.notifId}
                      notif={notif}
                      onClick={() => {
                        router.push(`/projects/${notif.projectId}?assetId=${notif.assetId}`);
                        setOpen(false);
                      }}
                    />
                  ))
            )}

            {activeTab === 'pipeline' && (
              pipelineNotifs.length === 0
                ? <div className="notif-empty">No pipeline notifications</div>
                : pipelineNotifs.map((notif) => {
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
                  })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
