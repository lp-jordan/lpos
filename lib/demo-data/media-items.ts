import { MediaItem } from '@/lib/models/media-item';

export const mediaItems: MediaItem[] = [
  {
    mediaItemId: 'm1',
    projectId: 'podcast-014',
    title: 'Podcast 014 Final Master',
    clientName: 'LeaderPass Media',
    collection: 'Podcast Season 1',
    category: 'Episode',
    provider: 'cloudflare',
    status: 'published',
    duration: '28:14',
    folderPath: 'LeaderPass Media/Podcast Season 1/Podcast 014',
    playbackUrl: 'https://media.example.com/podcast-014/master'
  },
  {
    mediaItemId: 'm2',
    projectId: 'chris-carneal-interview',
    title: 'Chris Carneal Interview Full Export',
    clientName: 'LeaderPass',
    collection: 'Executive Interviews',
    category: 'Interview',
    provider: 'cloudflare',
    status: 'ready',
    duration: '14:52',
    folderPath: 'LeaderPass/Executive Interviews/Chris Carneal',
    playbackUrl: 'https://media.example.com/chris-carneal/full'
  },
  {
    mediaItemId: 'm3',
    projectId: 'neil-entrepreneurship',
    title: 'Neil Entrepreneurship Module 1',
    clientName: 'LeaderPass',
    collection: 'Neil Course',
    category: 'Course Lesson',
    provider: 'sardius',
    status: 'published',
    duration: '09:41',
    folderPath: 'LeaderPass/Neil Course/Module 1',
    playbackUrl: 'https://legacy.example.com/neil/module-1'
  }
];
