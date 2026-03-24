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
import { useRouter } from 'next/navigation';
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

interface ToastRecord extends ToastInput {
  id: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
}

const DEFAULT_DURATION_MS = 5000;

const ToastContext = createContext<ToastContextValue>({
  toast: () => '',
  dismissToast: () => {},
});

function buildToastHref(toast: Pick<ToastRecord, 'projectId' | 'assetId'>): string | null {
  if (!toast.projectId) return null;
  if (!toast.assetId) return `/projects/${toast.projectId}`;
  const params = new URLSearchParams({ assetId: toast.assetId });
  return `/projects/${toast.projectId}?${params.toString()}`;
}

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
          durationMs: 7000,
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
          durationMs: 7000,
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
          durationMs: 7000,
        });
      }
    });

    uploadStatuses.current = nextStatuses;
  }, [uploadJobs, pushToast]);

  return null;
}

export function ToastProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const sequenceRef = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = input.id ?? `toast-${sequenceRef.current++}`;

    setToasts((prev) => {
      const nextToast: ToastRecord = { ...input, id };
      return [...prev.filter((toastItem) => toastItem.id !== id), nextToast];
    });

    const priorTimer = timersRef.current.get(id);
    if (priorTimer) window.clearTimeout(priorTimer);

    const timer = window.setTimeout(() => {
      dismissToast(id);
    }, input.durationMs ?? DEFAULT_DURATION_MS);

    timersRef.current.set(id, timer);
    return id;
  }, [dismissToast]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  const contextValue = useMemo(() => ({ toast, dismissToast }), [toast, dismissToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <QueueToastObserver pushToast={toast} />
      <div className="toast-viewport" aria-live="polite" aria-label="Notifications">
        {toasts.map((toastItem) => {
          const href = buildToastHref(toastItem);
          const isClickable = Boolean(href);
          return (
            <div
              key={toastItem.id}
              className={`app-toast app-toast--${toastItem.tone}${isClickable ? ' app-toast--clickable' : ''}`}
              role="status"
            >
              <button
                type="button"
                className="app-toast-body"
                onClick={() => {
                  if (href) router.push(href);
                  dismissToast(toastItem.id);
                }}
                disabled={!isClickable}
              >
                <span className="app-toast-title">{toastItem.title}</span>
                <span className="app-toast-copy">{toastItem.body}</span>
              </button>
              <button
                type="button"
                className="app-toast-close"
                onClick={() => dismissToast(toastItem.id)}
                aria-label={`Dismiss ${toastItem.title}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
