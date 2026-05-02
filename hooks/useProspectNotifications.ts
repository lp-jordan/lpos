'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io as socketIo, type Socket } from 'socket.io-client';
import type { ProspectNotification } from '@/lib/models/prospect-notification';

let sharedSocket: Socket | null = null;

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = socketIo({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return sharedSocket;
}

export function useProspectNotifications() {
  const [notifications, setNotifications] = useState<ProspectNotification[]>([]);
  const [unreadCount,   setUnreadCount]   = useState(0);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch('/api/notifications/prospects')
      .then((r) => r.json())
      .then((d: { notifications: ProspectNotification[]; unreadCount: number }) => {
        setNotifications(d.notifications);
        setUnreadCount(d.unreadCount);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const socket = getSocket();

    function onProspectNotif(notif: ProspectNotification) {
      setNotifications((prev) => [notif, ...prev].slice(0, 50));
      setUnreadCount((c) => c + 1);
    }

    socket.on('prospect:notification', onProspectNotif);
    return () => { socket.off('prospect:notification', onProspectNotif); };
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    fetch('/api/notifications/prospects', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ markAllRead: true }),
    }).catch(() => {});
  }, []);

  return { notifications, unreadCount, markAllRead };
}
