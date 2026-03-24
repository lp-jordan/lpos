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
import { ProjectStore } from '@/lib/store/project-store';
import { patchAsset } from '@/lib/store/media-registry';
import { getRuntimeDependencyReport } from './runtime-dependencies';

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
  var __lpos_io: SocketIOServer | undefined;
}

// ── Module-local singletons (fast path when module is shared) ─────────────
let registry: ServiceRegistry | null = null;
let slateService: SlateService | null = null;
let transcripterService: TranscripterService | null = null;
let passPrepService: PassPrepService | null = null;
let uploadQueueService: UploadQueueService | null = null;
let ingestQueueService: IngestQueueService | null = null;
let cameraControlService: CameraControlService | null = null;

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

  cameraControlService = new CameraControlService(io, registry);
  globalThis.__lpos_cameraControlService = cameraControlService;

  await Promise.all([
    slateService.start(),
    transcripterService.start(),
    passPrepService.start(),
    cameraControlService.start(),
  ]);
}

export async function stopServices(): Promise<void> {
  await Promise.all([
    slateService?.stop(),
    transcripterService?.stop(),
    passPrepService?.stop(),
    cameraControlService?.stop(),
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
