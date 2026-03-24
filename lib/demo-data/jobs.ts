import { Job } from '@/lib/models/job';

export const jobs: Job[] = [
  { jobId: 'j1', projectId: 'neil-entrepreneurship', type: 'sync_to_prompter', status: 'running', assignedTo: 'LeaderPrompt Stage Left', progress: 66 },
  { jobId: 'j2', projectId: 'chris-carneal-interview', type: 'editpanel_task', status: 'running', assignedTo: 'Editor Bay 2', progress: 42 },
  { jobId: 'j3', projectId: 'chris-carneal-interview', type: 'transcribe_media', status: 'completed', assignedTo: 'LPOS Host', progress: 100 },
  { jobId: 'j4', projectId: 'podcast-014', type: 'generate_pass_plan', status: 'queued', assignedTo: 'LPOS Host', progress: 0 },
  { jobId: 'j5', projectId: 'podcast-014', type: 'publish_media', status: 'blocked', assignedTo: 'Cloud Media Hub', progress: 0 }
];
