'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io as socketIo, type Socket } from 'socket.io-client';
import type { CommentNotification } from '@/lib/models/comment-notification';

let sharedSocket: Socket | null = null;

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = socketIo({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return sharedSocket;
}

export function useCommentNotifications() {
  const [notifications, setNotifications] = useState<CommentNotification[]>([]);
  const [unreadCount,   setUnreadCount]   = useState(0);
  const fetchedRef = useRef(false);
  const listRef = useRef<CommentNotification[]>([]);
  listRef.current = notifications;

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch('/api/notifications/comments')
      .then((r) => r.json())
      .then((d: { notifications: CommentNotification[]; unreadCount: number }) => {
        setNotifications(d.notifications);
        setUnreadCount(d.unreadCount);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const socket = getSocket();

    // A share review session re-sends its one item on every new comment:
    // replace it (and move it to the top) rather than adding a duplicate, and
    // only count it as newly unread if it had been read.
    function onCommentNotif(notif: CommentNotification) {
      const existing = listRef.current.find((n) => n.notifId === notif.notifId);
      if (!existing || existing.read) setUnreadCount((c) => c + 1);
      setNotifications((prev) => [notif, ...prev.filter((n) => n.notifId !== notif.notifId)].slice(0, 50));
    }

    socket.on('comment:notification', onCommentNotif);
    return () => { socket.off('comment:notification', onCommentNotif); };
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    fetch('/api/notifications/comments', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ markAllRead: true }),
    }).catch(() => {});
  }, []);

  return { notifications, unreadCount, markAllRead };
}
