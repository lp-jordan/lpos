'use client';

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import type { TranscriptJob } from '@/lib/services/transcripter-service';

export function useTranscriptQueue() {
  const [jobs, setJobs] = useState<TranscriptJob[]>([]);

  useEffect(() => {
    const socket = io('/transcripter', { transports: ['websocket'] });
    socket.on('queue', (q: TranscriptJob[]) => setJobs(q));
    return () => { socket.disconnect(); };
  }, []);

  return jobs;
}
