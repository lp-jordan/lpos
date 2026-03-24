import { Event } from '@/lib/models/event';

export const events: Event[] = [
  { eventId: 'e1', projectId: 'neil-entrepreneurship', timestamp: '2 min ago', type: 'prompter_sync', message: 'LeaderPrompt is syncing the latest script packet to Stage Left.' },
  { eventId: 'e2', projectId: 'neil-entrepreneurship', timestamp: '9 min ago', type: 'shoot_note', message: 'LeaderSlate logged a note for take timing and camera reset.' },
  { eventId: 'e3', projectId: 'chris-carneal-interview', timestamp: '21 min ago', type: 'transcription_complete', message: 'LeaderScript completed transcript and subtitle generation.' },
  { eventId: 'e4', projectId: 'chris-carneal-interview', timestamp: '24 min ago', type: 'editorial', message: 'EditPanel task packet assigned to Editor Bay 2.' },
  { eventId: 'e5', projectId: 'podcast-014', timestamp: '48 min ago', type: 'bundle_ready', message: 'Project bundle is ready for Pass Prep review.' },
  { eventId: 'e6', projectId: 'podcast-014', timestamp: '1 hr ago', type: 'prep_export', message: 'Workbook draft exported and attached to the project.' }
];
