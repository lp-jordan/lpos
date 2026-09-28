/**
 * Share view model — resolves a ShareLink into exactly what the viewer renders.
 *
 * Every share is an ordered list of videos (any project). Each video plays its
 * newest cut and gets a display title, in order of precedence:
 *   1. a manual title typed on the share
 *   2. its Platform tile title — live, so renaming the tile renames it here
 *   3. the LPOS asset name
 * Consecutive videos with the same `section` are grouped under that heading.
 */
import { getAsset } from '@/lib/store/media-registry';
import { findTilesForAsset, getPass, getPassTree, getTile } from '@/lib/store/platform-pass-store';
import { getProjectStore } from '@/lib/services/container';
import { listCanonicalMediaAssets } from '@/lib/store/canonical-asset-store';
import { downloadStatusFor, type AssetDownloadStatus } from '@/lib/services/share-downloads';
import {
  addShareItems,
  listShareItems,
  listShareLinks,
  type NewShareItem,
  type ShareCaps,
  type ShareLink,
  type ShareLinkItem,
} from '@/lib/store/share-links-db';

export type ShareTitleSource = 'manual' | 'platform' | 'lpos';

export interface ShareViewItem {
  assetId:       string;
  projectId:     string;
  /** What the viewer shows. */
  title:         string;
  titleSource:   ShareTitleSource;
  /** The title this video would have without a manual override. */
  autoTitle:     string;
  clientTitle:   string | null;
  /** LPOS asset name — shown to staff only. */
  lposName:      string;
  duration:      number | null;
  thumbnailUrl:  string;
  videoToken:    string;
  /** Where the player streams from: Frame.io/Cloudflare, the local file, or nowhere yet. */
  stream:        'frameio' | 'local' | null;
  /** Download files for this video (null when the share's Download switch is off). Served from R2, never LPOS. */
  download:      AssetDownloadStatus | null;
}

export interface ShareViewGroup {
  title: string | null;
  items: ShareViewItem[];
}

export interface ShareView {
  share:  Pick<ShareLink, 'id' | 'token' | 'name' | 'passId' | 'caps' | 'audience'>;
  groups: ShareViewGroup[];
}

/** The Platform title for a video: the tile it was added from if that tile still shows it, else its most recently edited tile. */
function platformTitle(assetId: string, titleTileId: string | null): string | null {
  if (titleTileId) {
    const tile = getTile(titleTileId);
    if (tile?.mediaAssetId === assetId && tile.title.trim()) return tile.title.trim();
  }
  const tile = findTilesForAsset(assetId).find((t) => t.title.trim());
  return tile ? tile.title.trim() : null;
}

function buildItem(it: ShareLinkItem, withDownloads: boolean): ShareViewItem | null {
  const asset = getAsset(it.projectId, it.assetId);
  if (!asset) return null;
  const lposName  = asset.name || asset.originalFilename;
  const fromTile  = platformTitle(it.assetId, it.titleTileId);
  const autoTitle = fromTile ?? lposName;
  return {
    assetId:      it.assetId,
    projectId:    it.projectId,
    title:        it.clientTitle ?? autoTitle,
    titleSource:  it.clientTitle ? 'manual' : fromTile ? 'platform' : 'lpos',
    autoTitle,
    clientTitle:  it.clientTitle,
    lposName,
    duration:     asset.duration,
    thumbnailUrl: `/api/projects/${it.projectId}/media/${it.assetId}/thumbnail`,
    videoToken:   it.videoToken,
    stream:       asset.frameio.assetId ? 'frameio' : asset.filePath ? 'local' : null,
    download:     withDownloads ? downloadStatusFor(it.assetId) : null,
  };
}

/** A pass's linked videos, in board order, sectioned by category — the starting list for a share made from a pass. */
export function passShareItems(passId: string): NewShareItem[] {
  const tree = getPassTree(passId);
  return (tree?.categories ?? []).flatMap((cat) => cat.tiles
    .filter((t) => t.mediaKind === 'video' && t.mediaAssetId && t.mediaProjectId)
    .map((t) => ({ assetId: t.mediaAssetId!, projectId: t.mediaProjectId!, section: cat.title, titleTileId: t.id })));
}

/** Shares made while pass shares read the pass live have no list of their own — give them one, once. */
function itemsFor(share: ShareLink): ShareLinkItem[] {
  let items = listShareItems(share.id);
  if (!items.length && share.passId) {
    addShareItems(share.id, passShareItems(share.passId));
    items = listShareItems(share.id);
  }
  return items;
}

export function resolveShareView(share: ShareLink): ShareView {
  const groups: ShareViewGroup[] = [];
  for (const it of itemsFor(share)) {
    const item = buildItem(it, share.caps.download);
    if (!item) continue;
    const last = groups[groups.length - 1];
    if (last && last.title === it.section) last.items.push(item);
    else groups.push({ title: it.section, items: [item] });
  }
  return {
    share: { id: share.id, token: share.token, name: share.name, passId: share.passId, caps: share.caps, audience: share.audience },
    groups,
  };
}

export interface ShareSummary {
  id:        string;
  token:     string;
  name:      string;
  passId:    string | null;
  passTitle: string | null;
  caps:      ShareCaps;
  audience:  ShareLink['audience'];
  emails:    string[];
  videoCount: number;
  projectIds: string[];
  updatedAt: string;
}

export function listShareSummaries(filter?: { projectId?: string; passId?: string; assetId?: string }): ShareSummary[] {
  const out: ShareSummary[] = [];
  for (const s of listShareLinks()) {
    if (filter?.passId && s.passId !== filter.passId) continue;
    const items = itemsFor(s);
    const projectIds = [...new Set(items.map((r) => r.projectId))];
    if (filter?.projectId && !projectIds.includes(filter.projectId)) continue;
    if (filter?.assetId && !items.some((r) => r.assetId === filter.assetId)) continue;
    out.push({
      id: s.id, token: s.token, name: s.name, passId: s.passId,
      passTitle: s.passId ? getPass(s.passId)?.title ?? null : null,
      caps: s.caps, audience: s.audience, emails: s.emails,
      videoCount: items.length, projectIds, updatedAt: s.updatedAt,
    });
  }
  return out;
}

export interface ShareAssetOption {
  assetId:      string;
  projectId:    string;
  projectName:  string;
  clientName:   string;
  name:         string;
  /** Platform tile title, when the video is on a tile — what the share will show. */
  platformTitle: string | null;
  duration:     number | null;
  thumbnailUrl: string;
  /** Playable on Cloudflare yet — the picker flags ones still processing. */
  cfReady:      boolean;
}

/** Videos that can go in a share, across every active project. `q` matches name, tile title, project or client. */
export function listShareableAssets(q: string, limit = 200): ShareAssetOption[] {
  const needle = q.trim().toLowerCase();
  const out: ShareAssetOption[] = [];
  for (const project of getProjectStore().getAll()) {
    if (project.archived) continue;
    for (const asset of listCanonicalMediaAssets(project.projectId)) {
      if (!asset.frameio.assetId && !asset.filePath) continue;
      const tileTitle = platformTitle(asset.assetId, null);
      const hay = `${asset.name} ${tileTitle ?? ''} ${project.name} ${project.clientName ?? ''}`.toLowerCase();
      if (needle && !hay.includes(needle)) continue;
      out.push({
        assetId: asset.assetId, projectId: project.projectId,
        projectName: project.name, clientName: project.clientName ?? '',
        name: asset.name || asset.originalFilename, platformTitle: tileTitle,
        duration: asset.duration,
        thumbnailUrl: `/api/projects/${project.projectId}/media/${asset.assetId}/thumbnail`,
        cfReady: asset.cloudflare?.status === 'ready',
      });
    }
  }
  out.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

// ── Browse (the Add-videos picker: clients → projects → videos) ───────────────

export interface BrowseClient  { clientName: string; projectCount: number; videoCount: number; latest: string }
export interface BrowseProject { projectId: string; name: string; clientName: string; videoCount: number; latest: string }

function shareableAssetsOf(projectId: string) {
  return listCanonicalMediaAssets(projectId).filter((a) => a.frameio.assetId || a.filePath);
}

/** Clients, newest activity first — the Projects page's order. */
export function browseClients(latestByProject: Map<string, string>): BrowseClient[] {
  const by = new Map<string, BrowseClient>();
  for (const p of getProjectStore().getAll()) {
    if (p.archived) continue;
    const c = by.get(p.clientName) ?? { clientName: p.clientName, projectCount: 0, videoCount: 0, latest: '' };
    c.projectCount += 1;
    c.videoCount += shareableAssetsOf(p.projectId).length;
    const ts = latestByProject.get(p.projectId) ?? p.updatedAt ?? '';
    if (ts > c.latest) c.latest = ts;
    by.set(p.clientName, c);
  }
  return [...by.values()].sort((a, b) => b.latest.localeCompare(a.latest));
}

export function browseProjects(clientName: string, latestByProject: Map<string, string>): BrowseProject[] {
  return getProjectStore().getAll()
    .filter((p) => !p.archived && p.clientName === clientName)
    .map((p) => ({
      projectId: p.projectId, name: p.name, clientName: p.clientName,
      videoCount: shareableAssetsOf(p.projectId).length,
      latest: latestByProject.get(p.projectId) ?? p.updatedAt ?? '',
    }))
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

export function browseVideos(projectId: string): { project: BrowseProject | null; videos: ShareAssetOption[] } {
  const project = getProjectStore().getAll().find((p) => p.projectId === projectId);
  if (!project) return { project: null, videos: [] };
  const videos = shareableAssetsOf(projectId).map((asset) => ({
    assetId: asset.assetId, projectId,
    projectName: project.name, clientName: project.clientName ?? '',
    name: asset.name || asset.originalFilename,
    platformTitle: platformTitle(asset.assetId, null),
    duration: asset.duration,
    thumbnailUrl: `/api/projects/${projectId}/media/${asset.assetId}/thumbnail`,
    cfReady: asset.cloudflare?.status === 'ready',
  }));
  return {
    project: { projectId, name: project.name, clientName: project.clientName, videoCount: videos.length, latest: project.updatedAt ?? '' },
    videos,
  };
}
