export type MediaProvider = 'cloudflare' | 'sardius';

export type MediaItemStatus = 'processing' | 'ready' | 'published';

export interface MediaItem {
  mediaItemId: string;
  projectId: string;
  title: string;
  clientName: string;
  collection: string;
  category: string;
  provider: MediaProvider;
  status: MediaItemStatus;
  duration: string;
  folderPath: string;
  playbackUrl: string;
}
