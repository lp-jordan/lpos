/**
 * Service container — module-level singletons with globalThis fallback.
 *
 * Next.js dev mode compiles API routes in a separate webpack bundle, which
 * means their module cache is DIFFERENT from the one server.ts uses.
 * We store the core singletons on globalThis so they survive that boundary
 * and any HMR module reloads that happen between requests.
 *
 * server.ts calls initServices() once on startup which:
 *   1. Attaches the real Socket.io server to every service (enables broadcasts)
 *   2. Starts long-running services (ATEM bridge, transcripter, etc.)
 *
 * API routes call the getters below. If initServices() hasn't run yet (edge
 * case: first request races startup) the ProjectStore lazily self-initialises
 * without a socket — data still persists, broadcasts are just skipped.
 */

import type { Server as SocketIOServer } from 'socket.io';
import { ServiceRegistry } from './registry';
import { SlateService } from './slate-service';
import { TranscripterService } from './transcripter-service';
import { PassPrepService } from './passprep-service';
import { UploadQueueService } from './upload-queue-service';
import { IngestQueueService } from './ingest-queue-service';
import { CameraControlService } from './camera-control-service';
import { AmaranService } from './amaran-service';
import {
  ActivityMonitorService,
  getActivityMonitorService,
  setActivityMonitorService,
} from './activity-monitor-service';
import { ProjectStore } from '@/lib/store/project-store';
import { ClientOwnerStore } from '@/lib/store/client-owner-store';
import { TaskStore } from '@/lib/store/task-store';
import { ProjectNoteStore } from '@/lib/store/project-note-store';
import { WishStore } from '@/lib/store/wish-store';
import { patchAsset } from '@/lib/store/media-registry';
import { getRuntimeDependencyReport } from './runtime-dependencies';
import { PipelineTrackerService } from './pipeline-tracker-service';
import { PresentationService } from './presentation-service';

// ── globalThis augmentation ───────────────────────────────────────────────
declare global {
  // eslint-disable-next-line no-var
  var __lpos_projectStore: ProjectStore | undefined;
  // eslint-disable-next-line no-var
  var __lpos_transcripterService: TranscripterService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_uploadQueueService: UploadQueueService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_ingestQueueService: IngestQueueService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_cameraControlService: CameraControlService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_activityMonitorService: ActivityMonitorService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_pipelineTracker: PipelineTrackerService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_clientOwnerStore: ClientOwnerStore | undefined;
  // eslint-disable-next-line no-var
  var __lpos_taskStore: TaskStore | undefined;
  // eslint-disable-next-line no-var
  var __lpos_projectNoteStore: ProjectNoteStore | undefined;
  // eslint-disable-next-line no-var
  var __lpos_wishStore: WishStore | undefined;
  // eslint-disable-next-line no-var
  var __lpos_io: SocketIOServer | undefined;
  // eslint-disable-next-line no-var
  var __lpos_amaranService: AmaranService | undefined;
  // eslint-disable-next-line no-var
  var __lpos_presentationService: PresentationService | undefined;
}

// ── Module-local singletons (fast path when module is shared) ─────────────
let registry: ServiceRegistry | null = null;
let slateService: SlateService | null = null;
let transcripterService: TranscripterService | null = null;
let passPrepService: PassPrepService | null = null;
let uploadQueueService: UploadQueueService | null = null;
let ingestQueueService: IngestQueueService | null = null;
let cameraControlService: CameraControlService | null = null;
let amaranService: AmaranService | null = null;
let activityMonitorService: ActivityMonitorService | null = null;
let pipelineTracker: PipelineTrackerService | null = null;
let clientOwnerStore: ClientOwnerStore | null = null;
let taskStore: TaskStore | null = null;
let projectNoteStore: ProjectNoteStore | null = null;
let wishStore: WishStore | null = null;
let presentationService: PresentationService | null = null;

// ── Init (called once from server.ts) ─────────────────────────────────────

export async function initServices(io: SocketIOServer): Promise<void> {
  const runtime = getRuntimeDependencyReport();
  runtime.dependencies
    .filter((dependency) => dependency.required && !dependency.available)
    .forEach((dependency) => {
      console.warn(`[lpos-runtime] ${dependency.label}: ${dependency.details}`);
    });

  // Persist io + projectStore globally so API routes can reach them
  globalThis.__lpos_io = io;

  if (globalThis.__lpos_projectStore) {
    globalThis.__lpos_projectStore.attachIo(io);
  } else {
    globalThis.__lpos_projectStore = new ProjectStore(io);
  }

  registry = new ServiceRegistry(io);
  slateService = new SlateService(io, registry, globalThis.__lpos_projectStore);

  transcripterService = new TranscripterService(io, registry);
  globalThis.__lpos_transcripterService = transcripterService;

  // Keep media-registry transcription status in sync when jobs finish
  transcripterService.onJobComplete((job) => {
    if (job.assetId) {
      patchAsset(job.projectId, job.assetId, {
        transcription: {
          status:      job.status === 'done' ? 'done' : 'failed',
          jobId:       job.jobId,
          completedAt: new Date().toISOString(),
        },
      });
    }
  });

  passPrepService = new PassPrepService(io, registry);

  uploadQueueService = new UploadQueueService(io);
  globalThis.__lpos_uploadQueueService = uploadQueueService;
  uploadQueueService.start();

  ingestQueueService = new IngestQueueService(io);
  globalThis.__lpos_ingestQueueService = ingestQueueService;
  ingestQueueService.start();

  pipelineTracker = new PipelineTrackerService(io, globalThis.__lpos_projectStore);
  pipelineTracker.subscribe(ingestQueueService, uploadQueueService, transcripterService);
  pipelineTracker.start();
  globalThis.__lpos_pipelineTracker = pipelineTracker;

  cameraControlService = new CameraControlService(io, registry);
  globalThis.__lpos_cameraControlService = cameraControlService;
  amaranService = new AmaranService(io);
  globalThis.__lpos_amaranService = amaranService;
  activityMonitorService = new ActivityMonitorService(io, registry);
  globalThis.__lpos_activityMonitorService = activityMonitorService;
  setActivityMonitorService(activityMonitorService);

  presentationService = new PresentationService(io);
  globalThis.__lpos_presentationService = presentationService;

  await Promise.all([
    slateService.start(),
    transcripterService.start(),
    passPrepService.start(),
    cameraControlService.start(),
    amaranService.start(),
    activityMonitorService.start(),
  ]);
}

export async function stopServices(): Promise<void> {
  pipelineTracker?.stop();
  uploadQueueService?.stop();
  await Promise.all([
    slateService?.stop(),
    transcripterService?.stop(),
    passPrepService?.stop(),
    cameraControlService?.stop(),
    amaranService?.stop(),
    activityMonitorService?.stop(),
  ]);
}

// ── Getters ───────────────────────────────────────────────────────────────

export function getProjectStore(): ProjectStore {
  // Fast path: module-local alias is set (same bundle as server.ts)
  if (globalThis.__lpos_projectStore) return globalThis.__lpos_projectStore;

  // Lazy init: API route bundle hasn't seen initServices() yet.
  // Create without socket — persists to disk, just no broadcast.
  globalThis.__lpos_projectStore = new ProjectStore();
  return globalThis.__lpos_projectStore;
}

export function getRegistry(): ServiceRegistry {
  if (!registry) throw new Error('Services not initialized — did server.ts run?');
  return registry;
}

export function getTranscripterService(): TranscripterService {
  if (globalThis.__lpos_transcripterService) return globalThis.__lpos_transcripterService;
  if (transcripterService) return transcripterService;
  throw new Error('TranscripterService not initialized — server.ts must be running');
}

export function getSlateService(): SlateService {
  if (!slateService) throw new Error('Services not initialized');
  return slateService;
}

export function getPassPrepService(): PassPrepService {
  if (!passPrepService) throw new Error('Services not initialized');
  return passPrepService;
}

export function getUploadQueueService(): UploadQueueService {
  if (globalThis.__lpos_uploadQueueService) return globalThis.__lpos_uploadQueueService;
  if (uploadQueueService) return uploadQueueService;
  throw new Error('UploadQueueService not initialized — server.ts must be running');
}

export function getIngestQueueService(): IngestQueueService {
  if (globalThis.__lpos_ingestQueueService) return globalThis.__lpos_ingestQueueService;
  if (ingestQueueService) return ingestQueueService;
  throw new Error('IngestQueueService not initialized — server.ts must be running');
}

export function getCameraControlService(): CameraControlService {
  if (globalThis.__lpos_cameraControlService) return globalThis.__lpos_cameraControlService;
  if (cameraControlService) return cameraControlService;

  cameraControlService = new CameraControlService(globalThis.__lpos_io);
  globalThis.__lpos_cameraControlService = cameraControlService;
  return cameraControlService;
}

export function getAmaranService(): AmaranService {
  if (globalThis.__lpos_amaranService) return globalThis.__lpos_amaranService;
  if (amaranService) return amaranService;
  // Lazy init without socket — allows API routes to work before server.ts has run
  amaranService = new AmaranService();
  globalThis.__lpos_amaranService = amaranService;
  return amaranService;
}

export function getActivityService(): ActivityMonitorService {
  if (globalThis.__lpos_activityMonitorService) return globalThis.__lpos_activityMonitorService;
  if (activityMonitorService) return activityMonitorService;
  const existing = getActivityMonitorService();
  if (existing) return existing;

  activityMonitorService = new ActivityMonitorService(globalThis.__lpos_io, null);
  globalThis.__lpos_activityMonitorService = activityMonitorService;
  setActivityMonitorService(activityMonitorService);
  return activityMonitorService;
}

export function getPipelineTrackerService(): PipelineTrackerService {
  if (globalThis.__lpos_pipelineTracker) return globalThis.__lpos_pipelineTracker;
  if (pipelineTracker) return pipelineTracker;
  throw new Error('PipelineTrackerService not initialized — server.ts must be running');
}

export function getClientOwnerStore(): ClientOwnerStore {
  if (globalThis.__lpos_clientOwnerStore) return globalThis.__lpos_clientOwnerStore;
  if (clientOwnerStore) return clientOwnerStore;
  clientOwnerStore = new ClientOwnerStore();
  globalThis.__lpos_clientOwnerStore = clientOwnerStore;
  return clientOwnerStore;
}

export function getTaskStore(): TaskStore {
  if (globalThis.__lpos_taskStore) return globalThis.__lpos_taskStore;
  if (taskStore) return taskStore;
  taskStore = new TaskStore();
  globalThis.__lpos_taskStore = taskStore;
  return taskStore;
}

export function getProjectNoteStore(): ProjectNoteStore {
  if (globalThis.__lpos_projectNoteStore) return globalThis.__lpos_projectNoteStore;
  if (projectNoteStore) return projectNoteStore;
  projectNoteStore = new ProjectNoteStore();
  globalThis.__lpos_projectNoteStore = projectNoteStore;
  return projectNoteStore;
}

export function getWishStore(): WishStore {
  if (globalThis.__lpos_wishStore) return globalThis.__lpos_wishStore;
  if (wishStore) return wishStore;
  wishStore = new WishStore();
  globalThis.__lpos_wishStore = wishStore;
  return wishStore;
}

export function getPresentationService(): PresentationService {
  if (globalThis.__lpos_presentationService) return globalThis.__lpos_presentationService;
  if (presentationService) return presentationService;
  throw new Error('PresentationService not initialized — server.ts must be running');
}
