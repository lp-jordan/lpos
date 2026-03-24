'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io }                                        from 'socket.io-client';
import type { IngestJob }                            from '@/lib/services/ingest-queue-service';

export function useIngestQueue() {
  const [jobs, setJobs]   = useState<IngestJob[]>([]);
  const socketRef         = useRef<ReturnType<typeof io> | null>(null);

  useEffect(() => {
    const socket = io('/media-ingest', { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('queue', (q: IngestJob[]) => setJobs(q));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  const cancel = useCallback((jobId: string) => {
    socketRef.current?.emit('cancel', jobId);
  }, []);

  return { jobs, cancel };
}
