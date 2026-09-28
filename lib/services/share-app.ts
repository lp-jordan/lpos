/**
 * LP Share sync — LPOS's side of the public share app (docs/share-app-spec.md).
 *
 * LPOS only ever calls out; LP Share never calls LPOS. Every tick:
 *   1. pull  — GET  /api/lpos/changes   comments clients made on LP Share → media_comments
 *   2. ack   — POST /api/lpos/changes/ack  (LP Share records the LPOS ids)
 *   3. push  — POST /api/lpos/shares    every share whose payload changed (full replace)
 *              POST /api/lpos/comments  every shared asset whose share threads changed
 *              (assets touched by the pull are always re-pushed)
 * Pushes are change-detected by hashing the payload (share_app_pushed table),
 * so an idle tick is one empty pull.
 *
 * Config:
 *   admin setting `share_app.origin`  — LP Share's URL. Lives in each LPOS's own
 *     database on purpose: Doppler is shared by prod and the dev tree, and a dev
 *     LPOS syncing with the real LP Share would pull (and ack) real client
 *     comments into dev data.
 *   SHARE_APP_INGEST_TOKEN (Doppler) — = LP Share's LPOS_INGEST_TOKEN
 *   SHARE_STAFF_SECRET     (Doppler) — signs staff tickets (see mintStaffTicket)
 */
import crypto from 'node:crypto';
import { getAsset } from '@/lib/store/media-registry';
import { getCurrentAssetVersion } from '@/lib/store/canonical-asset-store';
import { getCoreDb } from '@/lib/store/core-db';
import { getSetting, setSetting } from '@/lib/store/lpos-settings-store';
import { getUserById } from '@/lib/store/user-store';
import {
  getMediaCommentById,
  insertMediaComment,
  setMediaCommentCompletedById,
  softDeleteMediaCommentById,
  updateMediaCommentTextById,
} from '@/lib/store/media-comment-store';
import { getShareLink, getShareLinksDb, listShareItems, listShareLinks, type ShareCaps, type ShareLink } from '@/lib/store/share-links-db';
import { notifyShareActivity } from '@/lib/services/comment-notification-service';
import { resolveShareView } from '@/lib/services/share-links';
import { downloadStatusFor, readyDownloadFile } from '@/lib/services/share-downloads';
import { applyVideoSettings, cloudflareFrameThumbnailUrl, getVideoDetails } from '@/lib/services/cloudflare-stream';
import { loadTranscriptEditorPayload } from '@/lib/transcripts/editor-payload';

export { SHARE_APP_ORIGIN_KEY, shareAppOrigin } from '@/lib/services/share-app-config';
import { shareAppOrigin } from '@/lib/services/share-app-config';
const CURSOR_KEY = 'share_app.pull_cursor';
const TICK_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ── Config ────────────────────────────────────────────────────────────────────

function config(): { origin: string; token: string } | null {
  const origin = shareAppOrigin();
  const token = process.env.SHARE_APP_INGEST_TOKEN?.trim() ?? '';
  return origin && token ? { origin, token } : null;
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const cfg = config();
  if (!cfg) throw new Error('LP Share is not configured');
  const res = await fetch(`${cfg.origin}${path}`, {
    method,
    headers: { 'x-lpos-token': cfg.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// ── Payloads (shapes mirror lp-share lib/types.ts) ───────────────────────────

interface SharePayload {
  share: { id: string; token: string; name: string; audience: ShareLink['audience']; caps: ShareCaps; revoked: boolean; legacy_hub_id: string | null };
  emails: string[];
  items: Array<{
    asset_id: string; video_token: string; title: string; lpos_name: string; section: string | null;
    duration_s: number | null; hls_url: string | null; thumbnail_url: string | null;
    download: null | {
      state: 'preparing' | 'ready' | 'failed'; progress: number; error: string | null;
      original: { key: string; size: number; ext: string } | null;
      web: { key: string; size: number } | null;
      transcripts: Array<{ kind: 'srt' | 'vtt' | 'txt'; key: string }>;
    };
    transcript: Array<{ from_ms: number; text: string }> | null;
  }>;
}

interface LposComment {
  lpos_id: string; parent_lpos_id: string | null; share_id: string; share_comment_id: string | null;
  author_name: string; author_kind: 'guest' | 'email' | 'staff' | 'frameio';
  guest_id: string | null; email: string | null; staff_uid: string | null;
  text: string; timestamp_s: number | null; duration_s: number | null;
  completed: boolean; internal: boolean; created_at: string;
}

function transcriptCues(projectId: string, assetId: string): Array<{ from_ms: number; text: string }> | null {
  try {
    const cues = loadTranscriptEditorPayload(projectId, assetId)?.en?.cues ?? [];
    return cues.length ? cues.map((c) => ({ from_ms: c.fromMs, text: c.text })) : null;
  } catch {
    return null;
  }
}

function downloadPayload(assetId: string): SharePayload['items'][number]['download'] {
  const st = downloadStatusFor(assetId);
  if (st.state === 'none') return null;
  const key = (k: Parameters<typeof readyDownloadFile>[1]) => readyDownloadFile(assetId, k);
  const original = key('original');
  const web = key('web');
  return {
    state: st.state, progress: st.progress, error: st.error,
    original: original ? { key: original.key, size: original.size, ext: original.ext } : null,
    web: web ? { key: web.key, size: web.size } : null,
    transcripts: st.transcripts.flatMap((k) => { const f = key(k); return f ? [{ kind: k, key: f.key }] : []; }),
  };
}

export function buildSharePayload(share: ShareLink): SharePayload {
  const view = resolveShareView(share);
  const items: SharePayload['items'] = [];
  for (const g of view.groups) {
    for (const it of g.items) {
      const asset = getAsset(it.projectId, it.assetId);
      const cf = asset?.cloudflare;
      const playable = cf?.status === 'ready' && !!cf.hlsUrl;
      items.push({
        asset_id: it.assetId,
        video_token: it.videoToken,
        title: it.title,
        lpos_name: it.lposName,
        section: g.title,
        duration_s: it.duration,
        hls_url: playable ? cf!.hlsUrl : null,
        thumbnail_url: cf?.uid ? cloudflareFrameThumbnailUrl(cf.uid, Math.max(1, (it.duration ?? 10) * 0.1)) : null,
        download: share.caps.download ? downloadPayload(it.assetId) : null,
        transcript: share.caps.transcripts ? transcriptCues(it.projectId, it.assetId) : null,
      });
    }
  }
  return {
    share: {
      id: share.id, token: share.token, name: share.name, audience: share.audience, caps: share.caps,
      revoked: !!share.revokedAt, legacy_hub_id: null,
    },
    emails: share.emails,
    items,
  };
}

interface ShareCommentRow {
  comment_id: string; parent_comment_id: string | null; thread_root_id: string; share_id: string;
  share_comment_id: string | null; author_user_id: string | null; author_external_name: string | null;
  author_external_email: string | null; author_guest_id: string | null; source: string; body: string;
  timestamp_seconds: number | null; duration_seconds: number | null; completed: number;
  visibility: string | null; created_at: string;
}

/** The share threads on an asset's newest cut, as LP Share wants them. */
export function buildAssetComments(assetId: string): LposComment[] {
  const version = getCurrentAssetVersion(assetId);
  if (!version) return [];
  const rows = getCoreDb().prepare(
    `SELECT * FROM media_comments
      WHERE asset_id = ? AND asset_version_id = ? AND share_id IS NOT NULL AND deleted_at IS NULL
      ORDER BY created_at`,
  ).all(assetId, version.asset_version_id) as ShareCommentRow[];
  return rows.map((r) => {
    const user = r.author_user_id ? getUserById(r.author_user_id) : null;
    const kind: LposComment['author_kind'] = r.author_user_id ? 'staff'
      : r.source === 'frameio' ? 'frameio'
      : r.author_external_email && !r.author_guest_id ? 'email' : 'guest';
    return {
      lpos_id: r.comment_id,
      // LP Share threads are one level deep: replies hang off the thread root.
      parent_lpos_id: r.parent_comment_id ? r.thread_root_id : null,
      share_id: r.share_id,
      share_comment_id: r.share_comment_id,
      author_name: user?.name ?? r.author_external_name ?? 'Guest',
      author_kind: kind,
      guest_id: r.author_guest_id, email: r.author_external_email, staff_uid: r.author_user_id,
      text: r.body, timestamp_s: r.timestamp_seconds, duration_s: r.duration_seconds,
      completed: r.completed === 1, internal: r.visibility === 'internal', created_at: r.created_at,
    };
  });
}

// ── Change detection ──────────────────────────────────────────────────────────

function pushedDb() {
  const db = getShareLinksDb();
  db.exec(`CREATE TABLE IF NOT EXISTS share_app_pushed (
    kind TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, pushed_at TEXT NOT NULL, PRIMARY KEY (kind, id)
  )`);
  return db;
}

function hashOf(origin: string, value: unknown): string {
  return crypto.createHash('sha1').update(origin).update(JSON.stringify(value)).digest('hex');
}

function lastHash(kind: 'share' | 'asset', id: string): string | null {
  const r = pushedDb().prepare('SELECT hash FROM share_app_pushed WHERE kind = ? AND id = ?').get(kind, id) as { hash: string } | undefined;
  return r?.hash ?? null;
}

function recordHash(kind: 'share' | 'asset', id: string, hash: string): void {
  pushedDb().prepare(
    `INSERT INTO share_app_pushed (kind, id, hash, pushed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET hash = excluded.hash, pushed_at = excluded.pushed_at`,
  ).run(kind, id, hash, new Date().toISOString());
}

// ── Cloudflare: LP Share's host must be allowed to play each video ────────────

const originsEnsured = new Set<string>();

async function ensurePlayableFrom(origin: string, uids: string[]): Promise<void> {
  const host = new URL(origin).host.toLowerCase();
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return;   // dev: never touch Cloudflare
  for (const uid of uids) {
    const key = `${host}|${uid}`;
    if (originsEnsured.has(key)) continue;
    try {
      const { allowedOrigins } = await getVideoDetails(uid);
      // Empty list = no restriction; otherwise add our host (additive, keeps the rest).
      if (allowedOrigins.length && !allowedOrigins.map((o) => o.toLowerCase()).includes(host)) {
        await applyVideoSettings(uid, { allowedOrigins: [...allowedOrigins, host] });
      }
      originsEnsured.add(key);
    } catch (err) {
      console.warn(`[share-app] allowedOrigins for ${uid}:`, (err as Error).message);
    }
  }
}

// ── Pull: apply client comment changes ────────────────────────────────────────

interface CommentChange {
  seq: number;
  kind: 'create' | 'edit' | 'delete' | 'complete' | 'uncomplete';
  comment: {
    share_comment_id: string; lpos_id: string | null; share_id: string; asset_id: string;
    parent_share_comment_id: string | null; parent_lpos_id: string | null;
    author_name: string; author_kind: 'guest' | 'email' | 'staff' | 'frameio';
    guest_id: string | null; email: string | null; staff_uid: string | null;
    text: string; timestamp_s: number | null; duration_s: number | null;
    completed: boolean; internal: boolean; created_at: string; deleted: boolean;
  };
}

function localIdFor(c: CommentChange['comment']): string | null {
  if (c.lpos_id && getMediaCommentById(c.lpos_id)) return c.lpos_id;
  const r = getCoreDb().prepare('SELECT comment_id FROM media_comments WHERE share_comment_id = ?')
    .get(c.share_comment_id) as { comment_id: string } | undefined;
  return r?.comment_id ?? null;
}

/** Apply one change; returns the LPOS id of the comment it concerns (for ack mapping). */
function applyChange(ch: CommentChange): string | null {
  const c = ch.comment;
  const existing = localIdFor(c);

  if (!existing) {
    if (c.deleted) return null;   // made and deleted before we saw it
    const item = listShareItems(c.share_id).find((i) => i.assetId === c.asset_id);
    const version = getCurrentAssetVersion(c.asset_id);
    if (!item || !version) return null;
    const parentId = c.parent_lpos_id && getMediaCommentById(c.parent_lpos_id) ? c.parent_lpos_id
      : c.parent_share_comment_id ? localIdFor({ ...c, share_comment_id: c.parent_share_comment_id, lpos_id: null }) : null;
    const staffUser = c.author_kind === 'staff' && c.staff_uid ? getUserById(c.staff_uid) : null;
    const row = insertMediaComment({
      projectId: item.projectId,
      assetId: c.asset_id,
      assetVersionId: version.asset_version_id,
      parentCommentId: parentId,
      body: c.text,
      timestampSeconds: parentId ? null : c.timestamp_s,
      durationSeconds: parentId ? null : c.duration_s,
      authorUserId: staffUser?.id ?? null,
      authorExternalName: staffUser ? null : c.author_name,
      authorExternalEmail: staffUser ? null : c.email,
      source: 'lpos',
      completed: c.completed,
      visibility: c.internal ? 'internal' : null,
      shareId: c.share_id,
      shareCommentId: c.share_comment_id,
      authorGuestId: c.guest_id,
      createdAtOverride: c.created_at,
    });
    // A client comment → the rolling "reviewing" item in everyone's bell.
    if (!staffUser && c.author_kind !== 'staff') {
      const share = getShareLink(c.share_id);
      const asset = getAsset(item.projectId, c.asset_id);
      void notifyShareActivity({
        sessionKey: `${c.share_id}:${c.guest_id || c.email || c.author_name}`,
        shareId: c.share_id,
        shareToken: share?.token ?? '',
        shareName: share?.name ?? 'a share',
        projectId: item.projectId,
        assetId: c.asset_id,
        assetName: asset?.name || asset?.originalFilename || 'a video',
        commentId: row.commentId,
        fromName: c.author_name,
        snippet: c.text.slice(0, 140),
        at: c.created_at,
      }).catch((err) => console.warn('[share-app] notify failed:', (err as Error).message));
    }
    return row.commentId;
  }

  if (c.deleted || ch.kind === 'delete') { softDeleteMediaCommentById(existing); return existing; }
  if (ch.kind === 'complete' || ch.kind === 'uncomplete') {
    setMediaCommentCompletedById(existing, ch.kind === 'complete', c.staff_uid);
    return existing;
  }
  const current = getMediaCommentById(existing);
  if (current && current.body !== c.text) updateMediaCommentTextById(existing, c.text);
  return existing;
}

async function pullChanges(): Promise<{ cursor: number; mapped: Array<{ share_comment_id: string; lpos_id: string }>; assets: Set<string> } | null> {
  const since = getSetting<number>(CURSOR_KEY, 0);
  const res = await call<{ changes: CommentChange[]; cursor: number }>('GET', `/api/lpos/changes?since=${since}`);
  if (!res.changes.length) return null;
  const mapped: Array<{ share_comment_id: string; lpos_id: string }> = [];
  const assets = new Set<string>();
  for (const ch of res.changes) {
    try {
      const id = applyChange(ch);
      if (id) mapped.push({ share_comment_id: ch.comment.share_comment_id, lpos_id: id });
      assets.add(ch.comment.asset_id);
    } catch (err) {
      console.warn(`[share-app] change ${ch.seq} (${ch.kind}) failed:`, (err as Error).message);
    }
  }
  return { cursor: res.cursor, mapped, assets };
}

// ── Push ──────────────────────────────────────────────────────────────────────

async function pushShares(origin: string): Promise<void> {
  const live = listShareLinks();
  for (const share of live) {
    const payload = buildSharePayload(share);
    const hash = hashOf(origin, payload);
    if (lastHash('share', share.id) === hash) continue;
    const uids = payload.items.flatMap((i) => {
      const it = listShareItems(share.id).find((x) => x.assetId === i.asset_id);
      const uid = it ? getAsset(it.projectId, it.assetId)?.cloudflare?.uid : null;
      return uid ? [uid] : [];
    });
    await ensurePlayableFrom(origin, uids);
    await call('POST', '/api/lpos/shares', payload);
    recordHash('share', share.id, hash);
  }
  // Shares deleted in LPOS since the last push.
  const ids = new Set(live.map((s) => s.id));
  const pushed = pushedDb().prepare("SELECT id FROM share_app_pushed WHERE kind = 'share'").all() as Array<{ id: string }>;
  for (const { id } of pushed) {
    if (ids.has(id)) continue;
    await call('DELETE', `/api/lpos/shares/${encodeURIComponent(id)}`);
    pushedDb().prepare("DELETE FROM share_app_pushed WHERE kind = 'share' AND id = ?").run(id);
  }
}

async function pushComments(origin: string, force: Set<string>): Promise<void> {
  const assets = new Set<string>();
  for (const share of listShareLinks()) {
    if (share.revokedAt || !share.caps.comments) continue;
    for (const it of listShareItems(share.id)) assets.add(it.assetId);
  }
  for (const assetId of assets) {
    const comments = buildAssetComments(assetId);
    const hash = hashOf(origin, comments);
    if (!force.has(assetId) && lastHash('asset', assetId) === hash) continue;
    await call('POST', '/api/lpos/comments', { asset_id: assetId, comments });
    recordHash('asset', assetId, hash);
  }
}

// ── Loop ──────────────────────────────────────────────────────────────────────

export interface ShareAppSyncStatus { configured: boolean; lastOkAt: string | null; lastError: string | null }

declare global {
  // eslint-disable-next-line no-var
  var __lpos_share_app_sync: { timer: ReturnType<typeof setInterval>; running: boolean; status: ShareAppSyncStatus } | undefined;
}

export async function syncShareAppOnce(): Promise<void> {
  const cfg = config();
  const state = globalThis.__lpos_share_app_sync;
  if (state) state.status.configured = !!cfg;
  if (!cfg) return;
  try {
    // Ack BEFORE pushing: LP Share leaves rows with un-acked changes alone on a
    // push, so pushing first would drop LPOS-side changes (e.g. a completion)
    // made to a comment the client just edited. A push that fails after the ack
    // is retried next tick — its hash was never recorded.
    const pulled = await pullChanges();
    if (pulled) {
      await call('POST', '/api/lpos/changes/ack', { cursor: pulled.cursor, mapped: pulled.mapped });
      setSetting(CURSOR_KEY, pulled.cursor);
    }
    await pushShares(cfg.origin);
    await pushComments(cfg.origin, pulled?.assets ?? new Set());
    if (state) { state.status.lastOkAt = new Date().toISOString(); state.status.lastError = null; }
  } catch (err) {
    const msg = (err as Error).message;
    if (state && state.status.lastError !== msg) console.warn('[share-app] sync failed:', msg);
    if (state) state.status.lastError = msg;
  }
}

/** Start the sync loop once per process (safe to call repeatedly / across HMR). */
export function ensureShareAppSync(): void {
  if (globalThis.__lpos_share_app_sync) return;
  const state = {
    running: false,
    status: { configured: false, lastOkAt: null, lastError: null } as ShareAppSyncStatus,
    timer: setInterval(() => {
      if (state.running) return;
      state.running = true;
      void syncShareAppOnce().finally(() => { state.running = false; });
    }, TICK_MS),
  };
  globalThis.__lpos_share_app_sync = state;
}

export function shareAppSyncStatus(): ShareAppSyncStatus {
  return globalThis.__lpos_share_app_sync?.status ?? { configured: !!config(), lastOkAt: null, lastError: null };
}

// ── Staff tickets ─────────────────────────────────────────────────────────────

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A one-time, 60-second note saying "this is LPOS staff member X", which LP
 * Share turns into its own 30-day staff pass. Spec §3.
 */
export function mintStaffTicket(user: { id: string; name: string; email: string }): string | null {
  const secret = process.env.SHARE_STAFF_SECRET?.trim() ?? '';
  if (secret.length < 16) return null;
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({
    k: 'staff', uid: user.id, name: user.name, email: user.email, iat: now, exp: now + 60_000,
    jti: crypto.randomBytes(16).toString('hex'),
  })));
  const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}
