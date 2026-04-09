'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io as socketIo, type Socket } from 'socket.io-client';
import type { TaskNotification } from '@/lib/models/task-notification';

let sharedSocket: Socket | null = null;

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = socketIo({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return sharedSocket;
}

export function useTaskNotifications() {
  const [notifications, setNotifications] = useState<TaskNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch('/api/notifications/tasks')
      .then((r) => r.json())
      .then((d: { notifications: TaskNotification[]; unreadCount: number }) => {
        setNotifications(d.notifications);
        setUnreadCount(d.unreadCount);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const socket = getSocket();

    function onTaskNotif(notif: TaskNotification) {
      setNotifications((prev) => [notif, ...prev].slice(0, 50));
      setUnreadCount((c) => c + 1);
    }

    socket.on('task:notification', onTaskNotif);
    return () => { socket.off('task:notification', onTaskNotif); };
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    fetch('/api/notifications/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    }).catch(() => {});
  }, []);

  return { notifications, unreadCount, markAllRead };
}
