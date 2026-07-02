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
 *   Authorization: Bearer ${LPAI_INGEST_SECRET}     (== LP.AI's INGEST_SECRET)
 *   Body (one request per video):
 *     {
 *       "pass": "<project name>",
 *       "cloudflareUid": "<cf stream uid>",
 *       "title": "<video title>",
 *       "transcript": [ { "startMs": 0, "endMs": 6000, "text": "..." }, ... ]
 *     }
 *
 * Config:
 *   - LPAI_BASE_URL / LPAI_INGEST_SECRET are credentials → Doppler/env (per
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
import { getProjectStore } from '@/lib/services/container';

// ── Config (credentials from Doppler/env) ─────────────────────────────────────

interface LpaiConfig {
  baseUrl: string;
  secret: string;
}

/** Read + validate the LP.AI ingest config. Returns null if either value is unset. */
export function getLpaiConfig(): LpaiConfig | null {
  const baseUrl = process.env.LPAI_BASE_URL?.trim();
  const secret = process.env.LPAI_INGEST_SECRET?.trim();
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

/**
 * Decide whether a single asset is provisionable and build its payload.
 * Returns a reason string when it should be skipped.
 */
function buildPayload(projectName: string, asset: MediaAsset): { payload?: IngestPayload; skip?: string } {
  const cfUid = asset.cloudflare.uid;
  if (!cfUid) return { skip: 'No Cloudflare Stream UID (video not published to Cloudflare yet)' };
  if (asset.cloudflare.status !== 'ready') return { skip: `Cloudflare not ready (status=${asset.cloudflare.status})` };

  const jobId = asset.transcription.jobId;
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
    return { assetId, title, ok: false, skippedReason: 'LP.AI not configured (LPAI_BASE_URL / LPAI_INGEST_SECRET unset)' };
  }
  if (!asset) {
    return { assetId, title, ok: false, skippedReason: 'Asset not found' };
  }

  const project = getProjectStore().getById(projectId);
  const projectName = project?.name ?? projectId;

  const { payload, skip } = buildPayload(projectName, asset);
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
      details_json: { trigger: context.trigger, cloudflareUid: payload.cloudflareUid, cues: payload.transcript.length, pass: payload.pass },
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
