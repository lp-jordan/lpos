import { NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';
import { readRegistry } from '@/lib/store/media-registry';
import { readScriptsRegistry } from '@/lib/store/scripts-registry';

export interface ClientStatsMap {
  [clientName: string]: { mediaCount: number; scriptCount: number };
}

export async function GET() {
  try {
    const projects = getProjectStore().getAll().filter((p) => !p.archived);
    const stats: ClientStatsMap = {};

    for (const project of projects) {
      const client = project.clientName;
      if (!stats[client]) stats[client] = { mediaCount: 0, scriptCount: 0 };
      stats[client].mediaCount += readRegistry(project.projectId).length;
      stats[client].scriptCount += readScriptsRegistry(project.projectId).length;
    }

    return NextResponse.json({ stats });
  } catch {
    return NextResponse.json({ stats: {} });
  }
}
