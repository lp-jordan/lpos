'use client';

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import type { Task } from '@/lib/models/task';

interface Handlers {
  onCreated: (task: Task) => void;
  onUpdated: (task: Task) => void;
  onDeleted: (taskId: string) => void;
}

/**
 * Subscribes to the /tasks Socket.io namespace. Every task mutation that flows
 * through the API routes is broadcast here so other connected clients (or other
 * tabs of the same user) see the change without a manual refresh.
 *
 * The originator also receives their own broadcast. Handlers are expected to be
 * idempotent — applying an event for a task that's already in local state should
 * be safe (it just replaces with the server's authoritative copy).
 *
 * Handlers are captured by ref so callers can pass a fresh object literal each
 * render without triggering socket churn — the effect runs exactly once on mount.
 */
export function useTaskBroadcasts(handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = io('/tasks', { transports: ['websocket'] });
    socket.on('task:created', (task: Task) => handlersRef.current.onCreated(task));
    socket.on('task:updated', (task: Task) => handlersRef.current.onUpdated(task));
    socket.on('task:deleted', (payload: { taskId: string }) => handlersRef.current.onDeleted(payload.taskId));
    return () => { socket.disconnect(); };
  }, []);
}
