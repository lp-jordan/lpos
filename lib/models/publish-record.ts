export interface PublishRecord {
  publishRecordId: string;
  projectId: string;
  destination: string;
  status: 'draft' | 'published';
  url: string;
}
