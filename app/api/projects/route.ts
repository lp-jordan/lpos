import { NextRequest, NextResponse } from 'next/server';
import { getProjectStore } from '@/lib/services/container';

export async function GET() {
  try {
    const projects = getProjectStore().getAll();
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { name?: string; clientName?: string };
    const { name, clientName } = body;

    if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const project = getProjectStore().create({ name, clientName: clientName ?? '' });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
