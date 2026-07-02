/**
 * In-memory status registry for LP.AI provisioning, so the pipeline tray can
 * show a video's LeaderPass-AI provisioning lifecycle (queued → transcribing →
 * pushing → provisioned/failed) the same way it shows ingest/transcript/upload.
 *
 * Why a standalone module singleton (not a class service wired through the
 * composition root): provisioning is a set of module-level functions, and the
 * pipeline tracker only needs to *observe* status changes. Both sides import
 * this leaf module directly — no circular dependency, no DI plumbing.
 *
 * The provisioning functions call the `mark*` setters; the tracker subscribes
 * via `onChange` and maps each record to an `upload:lpai` pipeline stage. Live
 * transcription progress is fed separately by the tracker from the turbo sidecar
 * job (this store only carries coarse phase + a nominal progress).
 */

export type LpaiProvisioningPhase = 'queued' | 'transcribing' | 'pushing' | 'done' | 'failed';

export interface LpaiProvisioningRecord {
  assetId: string;
  projectId: string;
  filename: string;
  phase: LpaiProvisioningPhase;
  progress: number; // 0..100 (nominal; transcribing % is overridden live by the tracker)
  detail?: string;
  error?: string;
  /** Stable synthetic stage/pipeline id used by the tracker: `lpai:<assetId>`. */
  jobId: string;
  /** The turbo sidecar transcript job id, while transcribing. */
  sidecarJobId?: string;
  queuedAt: string;
  updatedAt: string;
  completedAt?: string;
}

type Listener = (record: LpaiProvisioningRecord) => void;

const TERMINAL: LpaiProvisioningPhase[] = ['done', 'failed'];

class LpaiProvisioningStatusStore {
  private records = new Map<string, LpaiProvisioningRecord>();
  private listeners = new Set<Listener>();

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get(assetId: string): LpaiProvisioningRecord | undefined {
    return this.records.get(assetId);
  }

  all(): LpaiProvisioningRecord[] {
    return Array.from(this.records.values());
  }

  private emit(rec: LpaiProvisioningRecord): void {
    for (const l of this.listeners) {
      try {
        l(rec);
      } catch (err) {
        console.error('[lpai-status] listener error', err);
      }
    }
  }

  private upsert(
    assetId: string,
    patch: Partial<Omit<LpaiProvisioningRecord, 'assetId' | 'jobId'>>,
  ): LpaiProvisioningRecord {
    const now = new Date().toISOString();
    const prev = this.records.get(assetId);
    const phase = patch.phase ?? prev?.phase ?? 'queued';
    const rec: LpaiProvisioningRecord = {
      assetId,
      projectId: patch.projectId ?? prev?.projectId ?? '',
      filename: patch.filename ?? prev?.filename ?? assetId,
      phase,
      progress: patch.progress ?? prev?.progress ?? 0,
      detail: 'detail' in patch ? patch.detail : prev?.detail,
      error: patch.error, // cleared unless explicitly provided
      jobId: `lpai:${assetId}`,
      sidecarJobId: patch.sidecarJobId ?? prev?.sidecarJobId,
      queuedAt: prev?.queuedAt ?? now,
      updatedAt: now,
      completedAt: TERMINAL.includes(phase) ? now : prev?.completedAt,
    };
    this.records.set(assetId, rec);
    this.emit(rec);
    return rec;
  }

  markQueued(assetId: string, projectId: string, filename: string): void {
    this.upsert(assetId, { projectId, filename, phase: 'queued', progress: 0, detail: 'Queued for LP.AI' });
  }

  markTranscribing(assetId: string, sidecarJobId: string): void {
    this.upsert(assetId, { phase: 'transcribing', sidecarJobId, detail: 'Transcribing (turbo)' });
  }

  markPushing(assetId: string): void {
    this.upsert(assetId, { phase: 'pushing', progress: 90, detail: 'Uploading to LP.AI' });
  }

  markDone(assetId: string): void {
    this.upsert(assetId, { phase: 'done', progress: 100, detail: 'Sent to LP.AI' });
  }

  markFailed(assetId: string, error: string): void {
    this.upsert(assetId, { phase: 'failed', error, detail: 'Provisioning failed' });
  }

  /** Drop terminal records older than ttl so the map doesn't grow unbounded. */
  prune(ttlMs = 60 * 60_000): void {
    const cutoff = Date.now() - ttlMs;
    for (const [id, r] of this.records) {
      if (TERMINAL.includes(r.phase) && r.completedAt && Date.parse(r.completedAt) < cutoff) {
        this.records.delete(id);
      }
    }
  }
}

export const lpaiProvisioningStatus = new LpaiProvisioningStatusStore();
