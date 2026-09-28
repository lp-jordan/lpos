/**
 * GET /api/share-links/browse                → { clients }            (newest activity first)
 * GET /api/share-links/browse?client=<name>  → { projects }           (that client's projects)
 * GET /api/share-links/browse?projectId=<id> → { project, videos }    (that project's videos)
 *
 * Backs the share window's Add-videos picker, which navigates like the
 * Projects page: clients → projects → videos.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProjectStore } from '@/lib/services/container';
import { getLatestActivityByProject } from '@/lib/store/activity-db';
import { browseClients, browseProjects, browseVideos } from '@/lib/services/share-links';

function latestActivity(): Map<string, string> {
  try { return getLatestActivityByProject(getProjectStore().getAll().map((p) => p.projectId)); }
  catch { return new Map(); }
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;
  const sp = new URL(req.url).searchParams;
  const projectId = sp.get('projectId');
  if (projectId) return NextResponse.json(browseVideos(projectId));
  const client = sp.get('client');
  if (client !== null) return NextResponse.json({ projects: browseProjects(client, latestActivity()) });
  return NextResponse.json({ clients: browseClients(latestActivity()) });
}
