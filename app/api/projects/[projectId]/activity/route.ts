import { NextRequest, NextResponse } from 'next/server';
import { getActivityService } from '@/lib/services/container';
import type { ActivityVisibility } from '@/lib/models/activity';

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get('limit') ?? 100);
    const visibility = searchParams.getAll('visibility') as ActivityVisibility[];

    const activity = getActivityService().listProjectActivity(projectId, {
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : 100,
      visibility,
    });

    return NextResponse.json({ activity });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
