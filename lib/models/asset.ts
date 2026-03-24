export type AssetType =
  | 'script'
  | 'video'
  | 'notes'
  | 'transcript'
  | 'subtitle'
  | 'project_bundle'
  | 'course_plan'
  | 'workbook'
  | 'published_media';

export type AssetStatus = 'uploaded' | 'processing' | 'ready';

export interface Asset {
  assetId: string;
  projectId: string;
  type: AssetType;
  name: string;
  source: string;
  status: AssetStatus;
  uploadedAt: string;
}
