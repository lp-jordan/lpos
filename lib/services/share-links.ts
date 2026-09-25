/**
 * Share view model — resolves a ShareLink into exactly what the viewer renders.
 *
 * Pass-backed shares read their videos, order, categories and client titles live
 * from the Platform pass tree (the pass IS the share). Ad-hoc shares read their
 * explicit list. Either way each video gets its per-video reshare token and, for
 * delivered shares, the version it was locked to.
 */
import { getAsset } from '@/lib/store/media-registry';
import { listAssetVersionsWithFrameioFileId } from '@/lib/store/canonical-asset-store';
import { getPass, getPassTree } from '@/lib/store/platform-pass-store';
import {
  ensureShareItemState,
  getShareItemState,
  listShareItems,
  listShareLinks,
  setShareItemPin,
  updateShareLink,
  type ShareCaps,
  type ShareLink,
} from '@/lib/store/share-links-db';

export interface ShareViewItem {
  assetId:       string;
  projectId:     string;
  /** Client-facing title (pass tile title, or the share's override, or the asset name). */
  title:         string;
  /** LPOS asset name — shown to staff only. */
  lposName:      string;
  duration:      number | null;
  thumbnailUrl:  string;
  /** The version the viewer should play: the pin on a delivered share, else latest. */
  version:       { id: string; number: number } | null;
  latestVersion: { id: string; number: number } | null;
  /** True when a delivered share is locked to an older cut than the latest. */
  updateAvailable: boolean;
  videoToken:    string;
  playable:      boolean;
  downloadable:  boolean;
}

export interface ShareViewGroup {
  title: string | null;
  items: ShareViewItem[];
}

export interface ShareView {
  share:  Pick<ShareLink, 'id' | 'token' | 'name' | 'passId' | 'stage' | 'caps' | 'audience'>;
  groups: ShareViewGroup[];
}

function latestVersionOf(assetId: string): { id: string; number: number } | null {
  const v = listAssetVersionsWithFrameioFileId(assetId)[0];
  return v ? { id: v.assetVersionId, number: v.versionNumber } : null;
}

function buildItem(share: ShareLink, assetId: string, projectId: string, title: string | null): ShareViewItem | null {
  const asset = getAsset(projectId, assetId);
  if (!asset) return null;
  const state  = ensureShareItemState(share.id, assetId, projectId);
  const latest = latestVersionOf(assetId);
  const pinned = share.stage === 'delivered' && state.pinnedVersionId && state.pinnedVersionNumber != null
    ? { id: state.pinnedVersionId, number: state.pinnedVersionNumber }
    : null;
  const version = pinned ?? latest;
  return {
    assetId,
    projectId,
    title:           (title ?? state.clientTitle ?? asset.name) || asset.originalFilename,
    lposName:        asset.name || asset.originalFilename,
    duration:        asset.duration,
    thumbnailUrl:    `/api/projects/${projectId}/media/${assetId}/thumbnail`,
    version,
    latestVersion:   latest,
    updateAvailable: !!(pinned && latest && latest.number > pinned.number),
    videoToken:      state.videoToken,
    playable:        !!(asset.frameio.assetId || asset.filePath),
    downloadable:    !!asset.filePath,
  };
}

export function resolveShareView(share: ShareLink): ShareView {
  const groups: ShareViewGroup[] = [];
  if (share.passId) {
    const tree = getPassTree(share.passId);
    for (const cat of tree?.categories ?? []) {
      const items = cat.tiles
        .filter((t) => t.mediaKind === 'video' && t.mediaAssetId && t.mediaProjectId)
        .map((t) => buildItem(share, t.mediaAssetId!, t.mediaProjectId!, t.title || null))
        .filter((x): x is ShareViewItem => !!x);
      if (items.length) groups.push({ title: cat.title, items });
    }
  } else {
    const items = listShareItems(share.id)
      .map((it) => buildItem(share, it.assetId, it.projectId, it.clientTitle))
      .filter((x): x is ShareViewItem => !!x);
    groups.push({ title: null, items });
  }
  return {
    share: { id: share.id, token: share.token, name: share.name, passId: share.passId, stage: share.stage, caps: share.caps, audience: share.audience },
    groups,
  };
}

/** Deliver: lock every video to its current latest version, turn downloads on, close comments. Same URL. */
export function deliverShare(share: ShareLink): ShareLink | null {
  const view = resolveShareView({ ...share, stage: 'review' });
  for (const g of view.groups) {
    for (const it of g.items) {
      if (it.latestVersion) setShareItemPin(share.id, it.assetId, it.projectId, { versionId: it.latestVersion.id, versionNumber: it.latestVersion.number });
    }
  }
  const caps: Partial<ShareCaps> = { download: true, comments: false, versions: true };
  return updateShareLink(share.id, { stage: 'delivered', caps });
}

/** Bump one delivered video to its latest version. */
export function bumpSharePin(share: ShareLink, assetId: string, projectId: string): void {
  const latest = latestVersionOf(assetId);
  if (latest) setShareItemPin(share.id, assetId, projectId, { versionId: latest.id, versionNumber: latest.number });
}

export interface ShareSummary {
  id:        string;
  token:     string;
  name:      string;
  passId:    string | null;
  passTitle: string | null;
  stage:     ShareLink['stage'];
  caps:      ShareCaps;
  audience:  ShareLink['audience'];
  emails:    string[];
  videoCount: number;
  projectIds: string[];
  updatedAt: string;
}

export function listShareSummaries(filter?: { projectId?: string; passId?: string }): ShareSummary[] {
  const out: ShareSummary[] = [];
  for (const s of listShareLinks()) {
    if (filter?.passId && s.passId !== filter.passId) continue;
    let refs: Array<{ assetId: string; projectId: string }>;
    if (s.passId) {
      const tree = getPassTree(s.passId);
      refs = (tree?.categories ?? []).flatMap((c) => c.tiles)
        .filter((t) => t.mediaKind === 'video' && t.mediaAssetId && t.mediaProjectId)
        .map((t) => ({ assetId: t.mediaAssetId!, projectId: t.mediaProjectId! }));
    } else {
      refs = listShareItems(s.id).map((i) => ({ assetId: i.assetId, projectId: i.projectId }));
    }
    const projectIds = [...new Set(refs.map((r) => r.projectId))];
    if (filter?.projectId && !projectIds.includes(filter.projectId)) continue;
    out.push({
      id: s.id, token: s.token, name: s.name, passId: s.passId,
      passTitle: s.passId ? getPass(s.passId)?.title ?? null : null,
      stage: s.stage, caps: s.caps, audience: s.audience, emails: s.emails,
      videoCount: refs.length, projectIds, updatedAt: s.updatedAt,
    });
  }
  return out;
}

export { getShareItemState };
