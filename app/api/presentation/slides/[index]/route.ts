import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ index: string }> },
) {
  const { index } = await params;
  const idx = parseInt(index, 10);

  if (Number.isNaN(idx) || idx < 0) {
    return NextResponse.json({ error: 'Invalid slide index' }, { status: 400 });
  }

  let service;
  try {
    const { getPresentationService } = await import('@/lib/services/container');
    service = getPresentationService();
  } catch {
    return NextResponse.json({ error: 'Presentation service unavailable' }, { status: 503 });
  }

  const slidePath = service.getSlide(idx);
  if (!slidePath) {
    return NextResponse.json({ error: 'Slide not found' }, { status: 404 });
  }

  try {
    const buffer = fs.readFileSync(slidePath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to read slide' }, { status: 500 });
  }
}
