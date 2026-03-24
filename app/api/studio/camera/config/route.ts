import { NextRequest, NextResponse } from 'next/server';
import { readStudioConfig, patchStudioConfig } from '@/lib/store/studio-config-store';
import type { CameraConfig } from '@/lib/store/studio-config-store';

export async function GET() {
  return NextResponse.json(readStudioConfig());
}

export async function PATCH(req: NextRequest) {
  try {
    const body   = await req.json() as { camera?: Partial<CameraConfig> };
    const config = patchStudioConfig({
      ...(body.camera ? { camera: body.camera as Partial<CameraConfig> } : {}),
    });
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
