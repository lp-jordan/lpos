export type JobType =
  | 'sync_to_prompter'
  | 'transcribe_media'
  | 'build_project_bundle'
  | 'editpanel_task'
  | 'generate_pass_plan'
  | 'publish_media';

export type JobStatus = 'queued' | 'running' | 'completed' | 'blocked';

export interface Job {
  jobId: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  assignedTo: string;
  progress: number;
}
