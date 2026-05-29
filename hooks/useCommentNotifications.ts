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

    function onCommentNotif(notif: CommentNotification) {
      setNotifications((prev) => [notif, ...prev].slice(0, 50));
      setUnreadCount((c) => c + 1);
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
