import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { readNotes, readTabs } from '@/lib/services/slate-service';

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * GET /api/ep/projects/:projectId/slate-notes
 *
 * Returns the project's production-slate notes and shoot-day tabs. EditPanel's
 * Timeline Setup task uses these to name each per-recording timeline (video
 * codes) and drop code markers. Distinct from /api/ep/projects/:id/notes, which
 * returns the general ProjectNotes (Slack-style annotations) — the slate notes
 * are the timestamped video-code + ATEM recording log stored per project under
 * data/projects/<id>/slate-notes.json.
 *
 * Each note is { timestamp: "HH:MM:SS:FF", code, note, tabId? }. Rows with
 * code === "ATEM" are the Recording started/stopped events; all other codes are
 * video codes. The caller filters as needed.
 *
 * Optional query: ?tab=<tabId> restricts notes to a single shoot-day tab.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const { projectId } = await params;
  const tab = req.nextUrl.searchParams.get('tab');

  let notes = readNotes(projectId);
  if (tab) notes = notes.filter((n) => n.tabId === tab);

  return NextResponse.json({ notes, tabs: readTabs(projectId) });
}
