'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io }                                        from 'socket.io-client';
import type { PipelineEntry, PipelineStageType }     from '@/lib/types/pipeline';

export function usePipelineQueue() {
  const [pipelines, setPipelines] = useState<PipelineEntry[]>([]);
  const socketRef                 = useRef<ReturnType<typeof io> | null>(null);

  useEffect(() => {
    // Fetch current state immediately so the page renders without waiting for
    // the socket handshake (which can take 2–4 s on first connection).
    fetch('/api/pipeline/entries')
      .then((r) => r.ok ? r.json() : null)
      .then((d: { entries: PipelineEntry[] } | null) => {
        if (d?.entries) setPipelines(d.entries);
      })
      .catch(() => { /* socket will catch up */ });

    const socket = io('/pipeline', { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('pipelines', (p: PipelineEntry[]) => setPipelines(p));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  const retry = useCallback((pipelineId: string, stageType: PipelineStageType) => {
    socketRef.current?.emit('retry', { pipelineId, stageType });
  }, []);

  const cancel = useCallback((pipelineId: string, stageType: PipelineStageType) => {
    socketRef.current?.emit('cancel', { pipelineId, stageType });
  }, []);

  const clearFailed = useCallback(() => {
    socketRef.current?.emit('clearFailed');
  }, []);

  const clearCancelled = useCallback(() => {
    socketRef.current?.emit('clearCancelled');
  }, []);

  return { pipelines, retry, cancel, clearFailed, clearCancelled };
}
