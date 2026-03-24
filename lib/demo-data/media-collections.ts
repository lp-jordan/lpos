import { MediaCollection } from '@/lib/models/media-collection';

export const mediaCollections: MediaCollection[] = [
  {
    collectionId: 'c1',
    name: 'Podcast Season 1',
    clientName: 'LeaderPass Media',
    description: 'Published episodes and draft exports for the first podcast release cycle.',
    itemCount: 8
  },
  {
    collectionId: 'c2',
    name: 'Executive Interviews',
    clientName: 'LeaderPass',
    description: 'Long-form interview masters, cutdowns, and hosted delivery links.',
    itemCount: 14
  },
  {
    collectionId: 'c3',
    name: 'Neil Course',
    clientName: 'LeaderPass',
    description: 'Course modules transitioning from Sardius-backed delivery into Cloudflare.',
    itemCount: 21
  }
];
