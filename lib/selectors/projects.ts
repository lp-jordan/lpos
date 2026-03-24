import { assets, events, jobs, publishRecords } from '@/lib/demo-data';
import { getProjectStore } from '@/lib/services/container';

export function getProjectById(projectId: string) {
  try {
    return getProjectStore().getById(projectId);
  } catch {
    // Container not yet initialized (e.g., during build)
    return null;
  }
}

export function getProjectAssets(projectId: string) {
  return assets.filter((asset) => asset.projectId === projectId);
}

export function getProjectJobs(projectId: string) {
  return jobs.filter((job) => job.projectId === projectId);
}

export function getProjectEvents(projectId: string) {
  return events.filter((event) => event.projectId === projectId);
}

export function getProjectPublishRecords(projectId: string) {
  return publishRecords.filter((record) => record.projectId === projectId);
}
