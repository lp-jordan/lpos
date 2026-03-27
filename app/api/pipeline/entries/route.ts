import { NextResponse } from 'next/server';
import { getPipelineTrackerService } from '@/lib/services/container';

function getTracker() {
  try { return getPipelineTrackerService(); } catch { return null; }
}

/** Returns the current pipeline entries snapshot for instant page-load hydration. */
export function GET() {
  const tracker = getTracker();
  if (!tracker) return NextResponse.json({ entries: [] });
  return NextResponse.json({ entries: tracker.getEntries() });
}
