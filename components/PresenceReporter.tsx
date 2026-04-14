'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

/**
 * Invisible component — opens a root-namespace socket and emits
 * presence:focus / presence:blur as the tab becomes visible or hidden.
 * Mount once in AppShell so it runs on every page.
 */
export function PresenceReporter() {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io('/', { transports: ['websocket'] });
    socketRef.current = socket;

    function reportState() {
      socket.emit(document.visibilityState === 'visible' ? 'presence:focus' : 'presence:blur');
    }

    // Report actual state as soon as the connection is established
    socket.on('connect', reportState);
    document.addEventListener('visibilitychange', reportState);

    return () => {
      socket.off('connect', reportState);
      document.removeEventListener('visibilitychange', reportState);
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return null;
}
