import { NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';

// Returns the project list from the ProjectStore directly.
// This avoids depending on SlateService being initialized (which lives in the
// server.ts module bundle, separate from the Next.js API route bundle).
export async function GET() {
  const projects = getProjectStore()
    .getAll()
    .map((p) => ({ projectId: p.projectId, name: p.name, clientName: p.clientName }));
  return NextResponse.json({ projects });
}
