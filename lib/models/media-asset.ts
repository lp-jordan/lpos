export type FrameIOStatus =
  | 'none'
  | 'uploading'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'needs_changes';

export const FRAMEIO_STATUS_LABEL: Record<FrameIOStatus, string> = {
  none:          'Not Uploaded',
  uploading:     'Uploading…',
  in_review:     'In Review',
  approved:      'Approved',
  rejected:      'Rejected',
  needs_changes: 'Needs Changes',
};

export interface FrameIOInfo {
  assetId: string | null;
  /** Frame.io version stack ID, set after the first versioning operation. */
  stackId: string | null;
  reviewLink: string | null;
  playerUrl: string | null;
  status: FrameIOStatus;
  version: number;
  uploadedAt: string | null;
  lastError: string | null;
}

export function defaultFrameIO(): FrameIOInfo {
  return {
    assetId: null,
    stackId: null,
    reviewLink: null,
    playerUrl: null,
    status: 'none',
    version: 1,
    uploadedAt: null,
    lastError: null,
  };
}

export type CloudflareStreamStatus =
  | 'none'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed';

export const CLOUDFLARE_STREAM_STATUS_LABEL: Record<CloudflareStreamStatus, string> = {
  none: 'Not Uploaded',
  uploading: 'Uploading…',
  processing: 'Processing…',
  ready: 'Ready',
  failed: 'Failed',
};

export interface CloudflareStreamInfo {
  uid: string | null;
  uploadUrl: string | null;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  hlsUrl: string | null;
  dashUrl: string | null;
  status: CloudflareStreamStatus;
  progress: number;
  uploadedAt: string | null;
  readyAt: string | null;
  creator: string | null;
  lastError: string | null;
  /** Cloudflare Images URL for the custom poster, set via Platform page when available. */
  posterUrl: string | null;
  /** LPOS asset version number this Cloudflare publication reflects. Null when no publication exists. */
  versionNumber: number | null;
  /** True when `versionNumber` is older than the asset's current version — the CF publication is stale. */
  isStale: boolean;
}

export function defaultCloudflareStream(): CloudflareStreamInfo {
  return {
    uid: null,
    uploadUrl: null,
    previewUrl: null,
    thumbnailUrl: null,
    hlsUrl: null,
    dashUrl: null,
    status: 'none',
    progress: 0,
    uploadedAt: null,
    readyAt: null,
    creator: null,
    lastError: null,
    posterUrl: null,
    versionNumber: null,
    isStale: false,
  };
}

/**
 * Resolve the URL to show as a video's *current* player poster: the custom
 * poster if one was set, otherwise Cloudflare Stream's auto-generated frame.
 * Returns null when the video isn't on Cloudflare yet. Single source of truth
 * for the distribution bar, the Set Thumbnail modal preview, etc.
 */
export function cloudflarePosterPreviewUrl(cf: CloudflareStreamInfo): string | null {
  if (cf.posterUrl) return cf.posterUrl;
  if (!cf.hlsUrl) return null;
  const base = cf.hlsUrl.replace('/manifest/video.m3u8', '');
  return `${base}/thumbnails/thumbnail.jpg`;
}

/**
 * The Cloudflare Stream embed ("stream") URL for an asset — the `/iframe` player
 * page, with the custom poster appended when present. Returns null when the asset
 * has no ready Cloudflare publication (no hlsUrl). Single source of truth for both
 * the MediaDistributionBar "Copy stream URL" action and the media-list context menu.
 */
export function cloudflareStreamEmbedUrl(cf: CloudflareStreamInfo): string | null {
  if (!cf.hlsUrl) return null;
  const base = cf.hlsUrl.replace('/manifest/video.m3u8', '');
  return `${base}/iframe${cf.posterUrl ? `?poster=${encodeURIComponent(cf.posterUrl)}` : ''}`;
}

export type LeaderPassStatus =
  | 'none'
  | 'preparing'
  | 'awaiting_platform'
  | 'published'
  | 'failed';

export const LEADERPASS_STATUS_LABEL: Record<LeaderPassStatus, string> = {
  none: 'Not Pushed',
  preparing: 'Preparing…',
  awaiting_platform: 'Awaiting Platform',
  published: 'Published',
  failed: 'Failed',
};

export interface LeaderPassPendingPayload {
  assetId: string;
  projectId: string;
  title: string;
  description: string;
  tags: string[];
  mimeType: string | null;
  fileSize: number | null;
  sourcePath: string | null;
  cloudflareStreamUid: string | null;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  preparedAt: string;
  replaceExistingCloudflareUid?: string | null;
  replaceExistingLeaderPassContentId?: string | null;
  replaceExistingLeaderPassTileId?: string | null;
}

export interface LeaderPassInfo {
  status: LeaderPassStatus;
  contentId: string | null;
  tileId: string | null;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  lastPreparedAt: string | null;
  publishedAt: string | null;
  lastError: string | null;
  pendingPayload: LeaderPassPendingPayload | null;
}

export function defaultLeaderPass(): LeaderPassInfo {
  return {
    status: 'none',
    contentId: null,
    tileId: null,
    playbackUrl: null,
    thumbnailUrl: null,
    lastPreparedAt: null,
    publishedAt: null,
    lastError: null,
    pendingPayload: null,
  };
}

export type TranscriptionStatus =
  | 'none'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed';

export interface TranscriptionInfo {
  status: TranscriptionStatus;
  jobId: string | null;
  completedAt: string | null;
  /** True when the transcription belongs to an older asset version (e.g. v1 transcript shown on v2). */
  fromPriorVersion: boolean;
  /** Version number the transcription was produced from, when fromPriorVersion is true. */
  sourceVersionNumber: number | null;
}

export function defaultTranscription(): TranscriptionInfo {
  return { status: 'none', jobId: null, completedAt: null, fromPriorVersion: false, sourceVersionNumber: null };
}

export type SardiusStatus = 'none' | 'uploading' | 'queued' | 'ready' | 'failed';

export const SARDIUS_STATUS_LABEL: Record<SardiusStatus, string> = {
  none:      'Not Pushed',
  uploading: 'Uploading…',
  queued:    'Processing in Sardius',
  ready:     'Ready',
  failed:    'Failed',
};

export interface SardiusInfo {
  status: SardiusStatus;
  remotePath: string | null;
  remoteFilename: string | null;
  shareUrl: string | null;
  uploadedAt: string | null;
  lastError: string | null;
}

export function defaultSardius(): SardiusInfo {
  return {
    status:         'none',
    remotePath:     null,
    remoteFilename: null,
    shareUrl:       null,
    uploadedAt:     null,
    lastError:      null,
  };
}

export type StorageType = 'uploaded' | 'registered';

/**
 * Editpanel render provenance for an asset that was rendered + uploaded by
 * editpanel (Phase 5c.1 — comment-marker tether).
 *
 * Captured at upload finalize; persisted as a row in the `editorial_links`
 * table joined to this asset. Null for assets uploaded via the browser, legacy
 * imports, or any non-editpanel source.
 *
 * `timelineUid` is the stable tether key (Resolve `Timeline.GetUniqueId()`) —
 * rename-safe, survives save/reopen + Resolve restart, but does NOT survive
 * .drt export+reimport or timeline duplicate (those genuinely are new
 * timelines).
 */
export interface EditpanelRenderInfo {
  timelineUid: string;
  timelineName: string;
  timelineStartTimecode: string;
  timelineFps: number;
  resolveProjectName: string;
  renderedAt: string;
  renderedFromMachine: string | null;
}

export interface MediaAsset {
  assetId: string;
  projectId: string;
  name: string;
  description: string;
  tags: string[];
  originalFilename: string;
  filePath: string | null;
  fileSize: number | null;
  mimeType: string | null;
  storageType: StorageType;
  duration: number | null;
  registeredAt: string;
  updatedAt: string;
  transcription: TranscriptionInfo;
  frameio: FrameIOInfo;
  cloudflare: CloudflareStreamInfo;
  leaderpass: LeaderPassInfo;
  sardius: SardiusInfo;
  editpanelRender: EditpanelRenderInfo | null;
}
