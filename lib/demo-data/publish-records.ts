import { PublishRecord } from '@/lib/models/publish-record';

export const publishRecords: PublishRecord[] = [
  {
    publishRecordId: 'p1',
    projectId: 'podcast-014',
    destination: 'Cloudflare Media Hub',
    status: 'published',
    url: 'https://media.example.com/podcast-014'
  }
];
