/**
 * lpai-provisioning.ts
 *
 * LPOS → LeaderPass AI ("LP.AI") provisioning. When a project has the
 * "Use in LeaderPass AI" toggle enabled, LPOS pushes that project's videos to
 * LP.AI's ingest endpoint so they become searchable/answerable inside LP.AI.
 *
 * This is the provisioning half of the LPOS↔LP.AI contract. The LP.AI side is
 * already built and MUST NOT be changed — we target its contract exactly:
 *
 *   POST ${LPAI_BASE_URL}/api/ingest
 *   Authorization: Bearer ${LPAI_PROVISIONING_SECRET}   (== LP.AI's PROVISIONING_SECRET)
 *   Body (one request per video):
 *     {
 *       "pass": "<project name>",
 *       "cloudflareUid": "<cf stream uid>",
 *       "title": "<video title>",
 *       "transcript": [ { "startMs": 0, "endMs": 6000, "text": "..." }, ... ]
 *     }
 *
 * Config:
 *   - LPAI_BASE_URL / LPAI_PROVISIONING_SECRET are credentials → Doppler/env (per
 *     feedback_doppler_secrets). If either is unset, provisioning is a no-op.
 *   - The per-project ON/OFF toggle is an operational knob → lpos_settings
 *     (per feedback_doppler_vs_admin_settings), keyed `lpai.enabled.<projectId>`.
 *
 * Transcript source preference (per the whisper-upgrade split):
 *   1. `<jobId>.words.json` — word-level, one entry per word with ms offsets.
 *   2. `<jobId>.json`       — whisper.cpp segment-level, transcription[] with
 *                             offsets.{from,to} (ms) + text.
 * Either is mapped to `[{ startMs, endMs, text }]`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MediaAsset } from '@/lib/models/media-asset';
import { readRegistry, getAsset } from '@/lib/store/media-registry';
import { getTranscriptPaths } from '@/lib/transcripts/store';
import { getSetting, setSetting } from '@/lib/store/lpos-settings-store';
import { recordActivity, serviceActor } from '@/lib/services/activity-monitor-service';
import { getProjectStore, getTranscripterService } from '@/lib/services/container';
import type { TranscriptJob } from '@/lib/services/transcripter-service';

// ── Turbo-on-provision config ────────────────────────────────────────────────

/**
 * The high-quality model produced at provision time. Normal LPOS ingest stays on
 * `base` (fast, snappy); only the LP.AI push gets this turbo pass. Overridable via
 * env for operators who staged a different large model, but defaults to the
 * recommended turbo build.
 */
export const LPAI_TURBO_MODEL = (process.env.LPAI_TURBO_MODEL?.trim() || 'large-v3-turbo');

/**
 * Whisper model names we accept as "turbo quality" for the cache check. If the
 * transcript that fed LP.AI was produced by one of these, we skip re-transcription.
 * large-v3 (non-turbo) is higher quality still, so it also satisfies the bar.
 */
const TURBO_QUALITY_MODELS = new Set<string>([LPAI_TURBO_MODEL, 'large-v3-turbo', 'large-v3']);

// ── Config (credentials from Doppler/env) ─────────────────────────────────────

interface LpaiConfig {
  baseUrl: string;
  secret: string;
}

/** Read + validate the LP.AI ingest config. Returns null if either value is unset. */
export function getLpaiConfig(): LpaiConfig | null {
  const baseUrl = process.env.LPAI_BASE_URL?.trim();
  const secret = process.env.LPAI_PROVISIONING_SECRET?.trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), secret };
}

/** True when LP.AI ingest is configured on this host. */
export function isLpaiConfigured(): boolean {
  return getLpaiConfig() !== null;
}

// ── Per-project toggle (operational knob in lpos_settings) ────────────────────

function toggleKey(projectId: string): string {
  return `lpai.enabled.${projectId}`;
}

/** Whether the "Use in LeaderPass AI" toggle is ON for a project. Default OFF. */
export function isProjectLpaiEnabled(projectId: string): boolean {
  return getSetting<boolean>(toggleKey(projectId), false);
}

/** Persist the per-project toggle. Returns the new value. */
export function setProjectLpaiEnabled(projectId: string, enabled: boolean): boolean {
  setSetting<boolean>(toggleKey(projectId), enabled);
  return enabled;
}

// ── Transcript → contract mapping ─────────────────────────────────────────────

export interface TranscriptCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** whisper.cpp `-oj` segment format. Offsets are integer milliseconds. */
interface WhisperSegmentJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number };
    timestamps?: { from?: string; to?: string };
    text?: string;
  }>;
}

/**
 * Word-level format produced by the separate whisper-upgrade work:
 * one entry per word, ms offsets. We tolerate a couple of shapes so this keeps
 * working whichever the upgrade lands on:
 *   { words: [ { startMs, endMs, word|text }, ... ] }
 *   [ { startMs, endMs, word|text }, ... ]
 *   { transcription: [ { offsets:{from,to}, text }, ... ] }   (same as segment)
 */
interface WordLevelJson {
  words?: Array<{ startMs?: number; endMs?: number; from?: number; to?: number; word?: string; text?: string }>;
}

function coerceCue(startMs: unknown, endMs: unknown, text: unknown): TranscriptCue | null {
  const s = Number(startMs);
  const e = Number(endMs);
  const t = typeof text === 'string' ? text.trim() : '';
  if (!Number.isFinite(s) || !Number.isFinite(e) || !t) return null;
  return { startMs: Math.max(0, Math.round(s)), endMs: Math.max(0, Math.round(e)), text: t };
}

/** Parse the word-level file if present. Returns null when absent/unusable. */
function readWordLevelTranscript(wordsPath: string): TranscriptCue[] | null {
  if (!fs.existsSync(wordsPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  } catch {
    return null;
  }

  // Shape A: bare array of word entries.
  const arr = Array.isArray(raw)
    ? raw
    : (raw as WordLevelJson).words;

  if (Array.isArray(arr)) {
    const cues = arr
      .map((w) => coerceCue(
        w?.startMs ?? w?.from,
        w?.endMs ?? w?.to,
        w?.word ?? w?.text,
      ))
      .filter((c): c is TranscriptCue => c !== null);
    return cues.length > 0 ? cues : null;
  }

  // Shape C: reuse the segment parser for a transcription[] payload.
  const segCues = parseWhisperSegments(raw as WhisperSegmentJson);
  return segCues.length > 0 ? segCues : null;
}

/** Map whisper.cpp segment JSON → cues using the ms `offsets`. */
function parseWhisperSegments(raw: WhisperSegmentJson): TranscriptCue[] {
  if (!Array.isArray(raw.transcription)) return [];
  return raw.transcription
    .map((seg) => coerceCue(seg?.offsets?.from, seg?.offsets?.to, seg?.text))
    .filter((c): c is TranscriptCue => c !== null);
}

function readSegmentTranscript(jsonPath: string): TranscriptCue[] {
  if (!fs.existsSync(jsonPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as WhisperSegmentJson;
    return parseWhisperSegments(raw);
  } catch {
    return [];
  }
}

/**
 * Load the transcript for an asset's transcription job, preferring the
 * word-level `<jobId>.words.json`, falling back to the segment-level
 * `<jobId>.json`. Returns an empty array when neither is usable.
 */
export function loadTranscriptCues(projectId: string, jobId: string): TranscriptCue[] {
  const { jsonPath } = getTranscriptPaths(projectId, jobId);
  const wordsPath = jsonPath.replace(/\.json$/, '.words.json');

  const wordLevel = readWordLevelTranscript(wordsPath);
  if (wordLevel && wordLevel.length > 0) return wordLevel;

  return readSegmentTranscript(jsonPath);
}

// ── Turbo-on-provision: high-quality word-level transcript, produced lazily ───
//
// Normal LPOS ingest transcribes on `base` (fast, snappy) and that transcript
// backs the Transcripts UI — we never touch it. At PROVISION time we want a
// high-quality `large-v3-turbo` WORD-LEVEL transcript for LP.AI. We produce it
// once per asset, cache the fact, and push it.
//
//   Cache marker : lpos_settings key `lpai.turbo.<projectId>.<assetId>` holding
//                  { model, jobId, completedAt }. Fast-path skip check.
//   Authority    : the marker's `<jobId>.words.json` must still exist on disk and
//                  the whisper JSON's `params.model` must be turbo-quality — so a
//                  hand-deleted or downgraded file forces a fresh pass.
//   Produce      : enqueueSidecar() with model=large-v3-turbo → a separate
//                  `<jobId>.*` fileset; only `.json`/`.words.json` are kept.
//   Wait         : an onJobComplete callback filtered on the sidecar jobId
//                  resolves a promise (non-blocking for the batch — each asset
//                  pushes as its own turbo job finishes).

interface TurboMarker {
  model: string;
  jobId: string;
  completedAt: string;
}

function turboMarkerKey(projectId: string, assetId: string): string {
  return `lpai.turbo.${projectId}.${assetId}`;
}

/** whisper.cpp `-oj` output includes a top-level `params.model` = absolute path to the ggml file. */
interface WhisperJsonWithParams {
  params?: { model?: string };
}

/** Extract the bare model name (e.g. "large-v3-turbo") from a whisper JSON's params.model path. */
function readModelFromWhisperJson(jsonPath: string): string | null {
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as WhisperJsonWithParams;
    const modelPath = raw.params?.model;
    if (typeof modelPath !== 'string' || !modelPath) return null;
    // params.model is a path like ".../ggml-large-v3-turbo.bin"; reduce to the bare name.
    const base = path.basename(modelPath).replace(/^ggml-/, '').replace(/\.bin$/i, '');
    return base || null;
  } catch {
    return null;
  }
}

/**
 * Has a turbo-quality word-level transcript already been produced for this asset?
 * Returns the jobId of the usable turbo transcript, or null if a fresh pass is
 * needed. Verified against disk + `params.model`, not just the cached marker, so
 * a deleted/downgraded file re-triggers.
 */
export function findCachedTurboJobId(projectId: string, assetId: string): string | null {
  const marker = getSetting<TurboMarker | null>(turboMarkerKey(projectId, assetId), null);
  if (!marker || !marker.jobId) return null;

  const { jsonPath } = getTranscriptPaths(projectId, marker.jobId);
  const wordsPath = jsonPath.replace(/\.json$/, '.words.json');
  // Word-level file is the whole point; if it's gone, the cache is stale.
  if (!fs.existsSync(wordsPath)) return null;

  // Confirm the on-disk transcript really was turbo quality. Prefer the words
  // JSON's params, fall back to the segment JSON's params.
  const producedModel = readModelFromWhisperJson(wordsPath) ?? readModelFromWhisperJson(jsonPath);
  if (producedModel && TURBO_QUALITY_MODELS.has(producedModel)) return marker.jobId;

  // Marker recorded a model but disk disagrees (or model unreadable) — if the
  // marker itself claims a turbo model and the words file exists, trust it; this
  // tolerates older whisper builds that omit params.model.
  if (!producedModel && TURBO_QUALITY_MODELS.has(marker.model)) return marker.jobId;

  return null;
}

function writeTurboMarker(projectId: string, assetId: string, marker: TurboMarker): void {
  setSetting<TurboMarker>(turboMarkerKey(projectId, assetId), marker);
}

/**
 * Ensure a turbo-quality word-level transcript exists for an asset, producing one
 * if needed, and return the jobId whose `<jobId>.words.json` / `<jobId>.json` hold
 * it. Non-blocking-friendly: it awaits the single turbo job for THIS asset (via a
 * completion callback) but callers fan these out per-asset so the batch never
 * blocks on the whole set serially.
 *
 * Returns null when no source file is available to transcribe.
 */
export async function ensureTurboTranscript(projectId: string, asset: MediaAsset): Promise<string | null> {
  const assetId = asset.assetId;

  // 1. Cache check — skip re-transcription if a turbo transcript already exists.
  const cached = findCachedTurboJobId(projectId, assetId);
  if (cached) {
    console.log(`[lpai] turbo transcript cache hit for asset ${assetId} (job ${cached})`);
    return cached;
  }

  // 2. Need the source media on disk to transcribe.
  if (!asset.filePath || !fs.existsSync(asset.filePath)) {
    console.warn(`[lpai] cannot produce turbo transcript for asset ${assetId}: source file missing (${asset.filePath ?? 'null'})`);
    return null;
  }

  // 3. Enqueue a turbo sidecar job and await ONLY that job's completion.
  const transcripter = getTranscripterService();
  const durationSec = typeof asset.duration === 'number' && asset.duration > 0 ? asset.duration : undefined;
  const displayName = asset.name || asset.originalFilename;

  const job = transcripter.enqueueSidecar(projectId, asset.filePath, assetId, {
    model: LPAI_TURBO_MODEL,
    durationSec,
    displayName,
  });

  console.log(`[lpai] awaiting turbo transcript for asset ${assetId} (job ${job.jobId}, model ${LPAI_TURBO_MODEL})`);

  const completed = await waitForJob(transcripter, job.jobId);
  if (completed.status !== 'done') {
    throw new Error(`Turbo transcription ${completed.status}${completed.error ? `: ${completed.error}` : ''}`);
  }

  // 4. Record the cache marker so re-provisions skip this work.
  writeTurboMarker(projectId, assetId, {
    model: LPAI_TURBO_MODEL,
    jobId: job.jobId,
    completedAt: new Date().toISOString(),
  });

  return job.jobId;
}

/**
 * Resolve when the transcripter job with `jobId` reaches a terminal state.
 * Uses the service's `onJobComplete` fan-out, filtered on jobId, and unregisters
 * the listener once it fires so provisioning batches don't leak callbacks.
 */
function waitForJob(
  transcripter: ReturnType<typeof getTranscripterService>,
  jobId: string,
): Promise<TranscriptJob> {
  return new Promise<TranscriptJob>((resolve) => {
    let settled = false;
    let unregister: (() => void) | null = null;
    const finish = (job: TranscriptJob) => {
      if (settled) return;
      settled = true;
      unregister?.();
      resolve(job);
    };

    unregister = transcripter.onJobComplete((job) => {
      if (job.jobId === jobId) finish(job);
    });

    // Guard the race where the job already finished before we registered: if it's
    // already terminal in the queue, resolve immediately.
    const existing = transcripter.getQueue().find((j) => j.jobId === jobId);
    if (existing && (existing.status === 'done' || existing.status === 'failed' || existing.status === 'canceled')) {
      finish(existing);
    }
  });
}

// ── HTTP push ─────────────────────────────────────────────────────────────────

export interface IngestPayload {
  pass: string;
  cloudflareUid: string;
  title: string;
  transcript: TranscriptCue[];
}

export interface IngestResult {
  assetId: string;
  title: string;
  ok: boolean;
  skippedReason?: string;
  error?: string;
}

/** POST a single video to LP.AI's ingest endpoint. Throws on network/HTTP error. */
async function postIngest(config: LpaiConfig, payload: IngestPayload): Promise<void> {
  const res = await fetch(`${config.baseUrl}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.secret}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`LP.AI ingest responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/** Fast CF-readiness gate. Returns a skip reason when the asset isn't provisionable yet. */
function checkCloudflareEligible(asset: MediaAsset): { cfUid?: string; skip?: string } {
  const cfUid = asset.cloudflare.uid;
  if (!cfUid) return { skip: 'No Cloudflare Stream UID (video not published to Cloudflare yet)' };
  if (asset.cloudflare.status !== 'ready') return { skip: `Cloudflare not ready (status=${asset.cloudflare.status})` };
  return { cfUid };
}

/**
 * Build the ingest payload from a SPECIFIC transcript jobId (normally the turbo
 * sidecar). Falls back to the base transcript jobId when no turbo job is given —
 * so provisioning still works if turbo production was skipped/failed.
 */
function buildPayload(
  projectName: string,
  asset: MediaAsset,
  transcriptJobId: string | null,
): { payload?: IngestPayload; skip?: string } {
  const { cfUid, skip } = checkCloudflareEligible(asset);
  if (!cfUid) return { skip };

  const jobId = transcriptJobId ?? asset.transcription.jobId;
  const cues = jobId ? loadTranscriptCues(asset.projectId, jobId) : [];
  // A transcript is not strictly required by the contract, but a video with no
  // transcript adds nothing to LP.AI — still push it so LP.AI knows it exists.
  const title = asset.name || asset.originalFilename;

  return {
    payload: {
      pass: projectName,
      cloudflareUid: cfUid,
      title,
      transcript: cues,
    },
  };
}

export type LpaiTrigger = 'toggle_on' | 'reprovision' | 'auto_finalize';

interface ProvisionContext {
  trigger: LpaiTrigger;
}

/**
 * Provision a single asset to LP.AI. Guarded on config + toggle by the caller
 * for batch flows; the auto-finalize hook calls this directly after checking
 * the toggle. Never throws — returns a per-asset result.
 */
export async function provisionAssetToLpai(
  projectId: string,
  assetId: string,
  context: ProvisionContext,
): Promise<IngestResult> {
  const config = getLpaiConfig();
  const asset = getAsset(projectId, assetId);
  const title = asset ? (asset.name || asset.originalFilename) : assetId;

  if (!config) {
    return { assetId, title, ok: false, skippedReason: 'LP.AI not configured (LPAI_BASE_URL / LPAI_PROVISIONING_SECRET unset)' };
  }
  if (!asset) {
    return { assetId, title, ok: false, skippedReason: 'Asset not found' };
  }

  const project = getProjectStore().getById(projectId);
  const projectName = project?.name ?? projectId;

  // CF-readiness gate first — no point producing an expensive turbo transcript for
  // a video LP.AI can't ingest yet (the contract requires a Cloudflare UID).
  const eligibility = checkCloudflareEligible(asset);
  if (eligibility.skip) {
    return { assetId, title, ok: false, skippedReason: eligibility.skip };
  }

  // Produce (or reuse the cached) high-quality turbo word-level transcript. This
  // is the turbo-on-provision step: normal ingest stays on `base`; only here do we
  // pay for large-v3-turbo, and only once per asset. On failure we don't abort —
  // we fall back to whatever base transcript exists so LP.AI still gets the video.
  let turboJobId: string | null = null;
  try {
    turboJobId = await ensureTurboTranscript(projectId, asset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[lpai] turbo transcript failed for asset ${assetId}; falling back to base transcript: ${message}`);
  }

  const { payload, skip } = buildPayload(projectName, asset, turboJobId);
  if (!payload) {
    return { assetId, title, ok: false, skippedReason: skip };
  }

  const actor = serviceActor('LeaderPass AI', 'lpai-provisioning');
  try {
    await postIngest(config, payload);
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: 'lpai.ingest.pushed',
      lifecycle_phase: 'completed',
      source_kind: 'background_service',
      visibility: 'user_timeline',
      title: `Pushed to LeaderPass AI: ${title}`,
      summary: `${title} was sent to LeaderPass AI ingest (${payload.transcript.length} transcript cues)`,
      client_id: project?.clientName ?? null,
      project_id: projectId,
      asset_id: assetId,
      source_service: 'lpai-provisioning',
      details_json: {
        trigger: context.trigger,
        cloudflareUid: payload.cloudflareUid,
        cues: payload.transcript.length,
        pass: payload.pass,
        transcriptModel: turboJobId ? LPAI_TURBO_MODEL : 'base (fallback)',
        transcriptJobId: turboJobId ?? asset.transcription.jobId,
      },
    });
    return { assetId, title, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordActivity({
      ...actor,
      occurred_at: new Date().toISOString(),
      event_type: 'lpai.ingest.failed',
      lifecycle_phase: 'failed',
      source_kind: 'background_service',
      visibility: 'operator_only',
      title: `LeaderPass AI push failed: ${title}`,
      summary: `${title} failed to push to LeaderPass AI ingest`,
      client_id: project?.clientName ?? null,
      project_id: projectId,
      asset_id: assetId,
      source_service: 'lpai-provisioning',
      details_json: { trigger: context.trigger, error: message },
    });
    console.error(`[lpai] ingest push failed for asset ${assetId}: ${message}`);
    return { assetId, title, ok: false, error: message };
  }
}

/**
 * Provision every eligible video in a project. Used on toggle-ON and by the
 * manual re-provision action. Per-video failures never abort the batch.
 * No-ops (returns empty summary) when LP.AI is unconfigured.
 */
export async function provisionProjectToLpai(
  projectId: string,
  context: ProvisionContext,
): Promise<{ configured: boolean; results: IngestResult[] }> {
  if (!isLpaiConfigured()) {
    console.warn(`[lpai] provisionProject skipped for ${projectId}: LP.AI not configured`);
    return { configured: false, results: [] };
  }

  let assets: MediaAsset[] = [];
  try {
    assets = readRegistry(projectId);
  } catch (err) {
    console.error(`[lpai] failed to read registry for ${projectId}:`, err);
    return { configured: true, results: [] };
  }

  const results: IngestResult[] = [];
  for (const asset of assets) {
    // Cheap pre-filter so we don't spam skip results for non-video / unpublished
    // assets. buildPayload re-checks authoritatively inside provisionAssetToLpai.
    if (!asset.cloudflare.uid || asset.cloudflare.status !== 'ready') continue;
    // eslint-disable-next-line no-await-in-loop -- sequential to be gentle on LP.AI
    const result = await provisionAssetToLpai(projectId, asset.assetId, context);
    results.push(result);
  }

  return { configured: true, results };
}

/**
 * Fire-and-forget project provisioning. Used by API routes that want to return
 * immediately (toggle-ON, media-finalization hook) without blocking on LP.AI.
 */
export function triggerProjectProvisioning(projectId: string, context: ProvisionContext): void {
  setImmediate(() => {
    void provisionProjectToLpai(projectId, context).catch((err) => {
      console.error(`[lpai] background project provisioning failed for ${projectId}:`, err);
    });
  });
}

/**
 * Auto-provision a single freshly-ready video, gated on the project toggle +
 * config. Called from the LeaderPass publish completion path — the moment a
 * video first has a Cloudflare UID. No-op (silent) when the toggle is off or
 * LP.AI is unconfigured, so it's safe to call unconditionally.
 */
export function triggerAutoProvisionOnFinalize(projectId: string, assetId: string): void {
  if (!isLpaiConfigured()) return;
  if (!isProjectLpaiEnabled(projectId)) return;
  setImmediate(() => {
    void provisionAssetToLpai(projectId, assetId, { trigger: 'auto_finalize' }).catch((err) => {
      console.error(`[lpai] auto-provision failed for asset ${assetId}:`, err);
    });
  });
}
