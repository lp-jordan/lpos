import { NextResponse } from 'next/server';
import { getStorageMountStatus } from '@/lib/services/storage-volume-service';

// Lightweight, non-admin-readable health signal for the app-wide drive-down
// banner. Reports whether every enabled storage drive (e.g. "LeaderPass Main")
// is currently mounted and writable. Authentication is enforced by middleware;
// the payload only exposes drive labels + availability, no config secrets.
export async function GET() {
  const status = getStorageMountStatus();
  return NextResponse.json(status, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
