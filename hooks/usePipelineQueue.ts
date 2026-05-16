'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io }                                        from 'socket.io-client';
import type { PipelineEntry, PipelineStageType }     from '@/lib/types/pipeline';

/** Composite key `pipelineId:stageType` — used to track which retries we've fired
 *  but haven't yet seen a server-side state update for. Keeps the Retry button
 *  from being clickable (and the "failed" row from staying visually failed)
 *  during the gap between the emit and the next snapshot. */
function retryKey(pipelineId: string, stageType: PipelineStageType): string {
  return `${pipelineId}:${stageType}`;
}

export function usePipelineQueue() {
  const [pipelines, setPipelines] = useState<PipelineEntry[]>([]);
  const [retryPending, setRetryPending] = useState<Set<string>>(() => new Set());
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
    socket.on('pipelines', (p: PipelineEntry[]) => {
      setPipelines(p);
      // Any fresh server snapshot supersedes our local "retry just emitted" hint.
      // If the retry is still queuing on the server, the stage will arrive back as
      // 'queued'/'running' (not 'failed') so the Retry button stays hidden anyway.
      setRetryPending((prev) => (prev.size === 0 ? prev : new Set()));
    });
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  const retry = useCallback((pipelineId: string, stageType: PipelineStageType) => {
    socketRef.current?.emit('retry', { pipelineId, stageType });
    setRetryPending((prev) => {
      const next = new Set(prev);
      next.add(retryKey(pipelineId, stageType));
      return next;
    });
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

  const isRetryPending = useCallback(
    (pipelineId: string, stageType: PipelineStageType) => retryPending.has(retryKey(pipelineId, stageType)),
    [retryPending],
  );

  return { pipelines, retry, cancel, clearFailed, clearCancelled, isRetryPending };
}
