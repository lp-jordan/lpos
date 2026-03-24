import { NextResponse } from 'next/server';
import { getCameraControlService } from '@/lib/services/container';

export async function GET() {
  try {
    const camera = getCameraControlService();
    const cameras = await camera.discoverCameras();
    return NextResponse.json({ cameras });
  } catch (err) {
    const message = (err as Error).message;
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
