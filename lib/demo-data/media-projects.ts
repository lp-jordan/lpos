export type AssetStatus = 'draft' | 'in_review' | 'approved' | 'published';

export interface MediaProject {
  projectId: string;
  clientName: string;
  projectName: string;
  videoCount: number;
  currentRound: number;
  lastActivity: string;
  pendingReview: number;
  status: AssetStatus;
}

export interface AssetVersion {
  round: number;
  uploadDate: string;
  uploader: string;
  action: 'uploaded' | 'replaced';
}

// Maps 1:1 to a Frame.io comment on an asset
export interface FrameIoComment {
  id: string;
  author: string;
  authorInitial: string;
  timecode: string;      // e.g. "1:23" — clicking seeks the player
  text: string;
  resolved: boolean;
  createdAt: string;
}

export interface MediaAsset {
  assetId: string;
  projectId: string;
  title: string;
  description: string;
  duration: string;
  round: number;
  status: AssetStatus;
  uploadDate: string;
  uploader: string;
  streamUrl: string;
  embedUrl: string;
  versions: AssetVersion[];
  // Frame.io integration fields
  frameIoAssetId?: string;
  frameIoReviewLink?: string;
  comments?: FrameIoComment[];
}

// Media projects are now derived from the ProjectStore (lib/store/project-store.ts).
export const mediaProjects: MediaProject[] = [];

export const mediaAssets: Record<string, MediaAsset[]> = {};
