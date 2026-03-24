'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io }                                        from 'socket.io-client';
import type { UploadJob }                            from '@/lib/services/upload-queue-service';

export function useUploadQueue() {
  const [jobs, setJobs]   = useState<UploadJob[]>([]);
  const socketRef         = useRef<ReturnType<typeof io> | null>(null);

  useEffect(() => {
    const socket = io('/upload-queue', { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('queue', (q: UploadJob[]) => setJobs(q));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  const cancel = useCallback((jobId: string) => {
    socketRef.current?.emit('cancel', jobId);
  }, []);

  return { jobs, cancel };
}
