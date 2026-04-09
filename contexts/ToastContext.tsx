'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIngestQueue } from '@/hooks/useIngestQueue';
import { useTranscriptQueue } from '@/hooks/useTranscriptQueue';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import type { IngestJob } from '@/lib/services/ingest-queue-service';
import type { TranscriptJob } from '@/lib/services/transcripter-service';
import type { UploadJob } from '@/lib/services/upload-queue-service';

type ToastTone = 'success' | 'error' | 'info';
type ToastKind = 'ingest' | 'transcription' | 'publish' | 'comment';

interface ToastInput {
  id?: string;
  kind: ToastKind;
  title: string;
  body: string;
  tone: ToastTone;
  projectId?: string;
  assetId?: string;
  jobId?: string;
  durationMs?: number;
}

export interface NotificationRecord {
  id: string;
  kind: ToastKind;
  title: string;
  body: string;
  tone: ToastTone;
  projectId?: string;
  assetId?: string;
  jobId?: string;
  timestamp: number;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
  notifications: NotificationRecord[];
  unreadCount: number;
  markAllRead: () => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => '',
  dismissToast: () => {},
  notifications: [],
  unreadCount: 0,
  markAllRead: () => {},
});

function QueueToastObserver({ pushToast }: Readonly<{ pushToast: (input: ToastInput) => string }>) {
  const { jobs: ingestJobs } = useIngestQueue();
  const transcriptJobs = useTranscriptQueue();
  const { jobs: uploadJobs } = useUploadQueue();
  const hasSeenIngest = useRef(false);
  const hasSeenTranscript = useRef(false);
  const hasSeenUpload = useRef(false);
  const ingestStatuses = useRef<Map<string, IngestJob['status']>>(new Map());
  const transcriptStatuses = useRef<Map<string, TranscriptJob['status']>>(new Map());
  const uploadStatuses = useRef<Map<string, UploadJob['status']>>(new Map());

  useEffect(() => {
    const nextStatuses = new Map(ingestJobs.map((job) => [job.jobId, job.status]));
    if (!hasSeenIngest.current) {
      ingestStatuses.current = nextStatuses;
      hasSeenIngest.current = true;
      return;
    }

    ingestJobs.forEach((job) => {
      const previous = ingestStatuses.current.get(job.jobId);
      if (!previous || previous === job.status) return;
      if (job.status === 'done') {
        pushToast({
          id: `ingest:${job.jobId}:done`,
          kind: 'ingest',
          tone: 'success',
          title: 'Ingest Complete',
          body: job.filename,
          projectId: job.projectId,
          assetId: job.assetId || undefined,
          jobId: job.jobId,
        });
      } else if (job.status === 'failed') {
        pushToast({
          id: `ingest:${job.jobId}:failed`,
          kind: 'ingest',
          tone: 'error',
          title: 'Ingest Failed',
          body: job.error ? `${job.filename}: ${job.error}` : job.filename,
          projectId: job.projectId,
          assetId: job.assetId || undefined,
          jobId: job.jobId,
        });
      }
    });

    ingestStatuses.current = nextStatuses;
  }, [ingestJobs, pushToast]);

  useEffect(() => {
    const nextStatuses = new Map(transcriptJobs.map((job) => [job.jobId, job.status]));
    if (!hasSeenTranscript.current) {
      transcriptStatuses.current = nextStatuses;
      hasSeenTranscript.current = true;
      return;
    }

    transcriptJobs.forEach((job) => {
      const previous = transcriptStatuses.current.get(job.jobId);
      if (!previous || previous === job.status) return;
      if (job.status === 'done') {
        pushToast({
          id: `transcription:${job.jobId}:done`,
          kind: 'transcription',
          tone: 'success',
          title: 'Transcription Complete',
          body: job.filename,
          projectId: job.projectId,
          assetId: job.assetId,
          jobId: job.jobId,
        });
      } else if (job.status === 'failed') {
        pushToast({
          id: `transcription:${job.jobId}:failed`,
          kind: 'transcription',
          tone: 'error',
          title: 'Transcription Failed',
          body: job.error ? `${job.filename}: ${job.error}` : job.filename,
          projectId: job.projectId,
          assetId: job.assetId,
          jobId: job.jobId,
        });
      }
    });

    transcriptStatuses.current = nextStatuses;
  }, [transcriptJobs, pushToast]);

  useEffect(() => {
    const nextStatuses = new Map(uploadJobs.map((job) => [job.jobId, job.status]));
    if (!hasSeenUpload.current) {
      uploadStatuses.current = nextStatuses;
      hasSeenUpload.current = true;
      return;
    }

    uploadJobs.forEach((job) => {
      const previous = uploadStatuses.current.get(job.jobId);
      if (!previous || previous === job.status) return;
      const isLeaderPass = job.provider === 'leaderpass';
      if (job.status === 'done') {
        pushToast({
          id: `publish:${job.jobId}:done`,
          kind: 'publish',
          tone: 'success',
          title: isLeaderPass ? 'LeaderPass Publish Complete' : 'Frame.io Upload Complete',
          body: job.filename,
          projectId: job.projectId,
          assetId: job.assetId,
          jobId: job.jobId,
        });
      } else if (job.status === 'failed') {
        pushToast({
          id: `publish:${job.jobId}:failed`,
          kind: 'publish',
          tone: 'error',
          title: isLeaderPass ? 'LeaderPass Publish Failed' : 'Frame.io Upload Failed',
          body: job.error ? `${job.filename}: ${job.error}` : job.filename,
          projectId: job.projectId,
          assetId: job.assetId,
          jobId: job.jobId,
        });
      }
    });

    uploadStatuses.current = nextStatuses;
  }, [uploadJobs, pushToast]);

  return null;
}

const MAX_NOTIFICATIONS = 50;

export function ToastProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [lastReadAt, setLastReadAt] = useState<number>(() => Date.now());
  const sequenceRef = useRef(0);

  const unreadCount = useMemo(
    () => notifications.filter((n) => n.timestamp > lastReadAt).length,
    [notifications, lastReadAt],
  );

  const markAllRead = useCallback(() => {
    setLastReadAt(Date.now());
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = input.id ?? `toast-${sequenceRef.current++}`;

    setNotifications((prev) => {
      const record: NotificationRecord = {
        id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        tone: input.tone,
        projectId: input.projectId,
        assetId: input.assetId,
        jobId: input.jobId,
        timestamp: Date.now(),
      };
      const filtered = prev.filter((n) => n.id !== id);
      return [record, ...filtered].slice(0, MAX_NOTIFICATIONS);
    });

    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const contextValue = useMemo(
    () => ({ toast, dismissToast, notifications, unreadCount, markAllRead }),
    [toast, dismissToast, notifications, unreadCount, markAllRead],
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <QueueToastObserver pushToast={toast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
