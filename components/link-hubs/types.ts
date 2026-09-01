// Pure client-safe types for the Link Hubs UI (no server-only imports).

export type OwnerType = 'client' | 'person' | 'leaderpass';

export interface HubSummary {
  id: string;
  name: string;
  owner_label: string;
  owner_type: OwnerType;
  created_at: string;
  updated_at: string;
  video_count: number;
  access_count: number;
}

export interface HubItem {
  asset_id: string;
  project_id: string;
  client_title: string;
  share_token: string;
  sort_order: number;
}

export interface HubDetail {
  hub: {
    id: string;
    name: string;
    owner_label: string;
    owner_type: OwnerType;
    created_at: string;
    updated_at: string;
  };
  items: HubItem[];
  access: string[];
}

export interface AssetOption {
  assetId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  name: string;
  durationS: number;
  thumbnailUrl: string | null;
  cfStatus: string | null;
}

export const OWNER_LABELS: Record<OwnerType, string> = {
  client: 'Client',
  person: 'Person',
  leaderpass: 'LeaderPass',
};

export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}
