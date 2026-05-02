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
  commentCount: number;
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
    commentCount: 0,
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
  };
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
}
