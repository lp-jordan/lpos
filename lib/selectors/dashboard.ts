import { events, mediaItems } from '@/lib/demo-data';

export function getDashboardStats(projectCount = 0) {
  return {
    activeProjects: projectCount,
    mediaAssets: mediaItems.length,
    teamMembers: 4,
  };
}

export function getRecentEvents(limit = 5) {
  return events.slice(0, limit);
}
