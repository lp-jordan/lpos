/**
 * GET  /api/auth/frameio/status  — returns connection state
 * DELETE /api/auth/frameio/status — disconnects (removes stored tokens)
 */

import { NextResponse } from 'next/server';
import { isConnected, connectedAt, disconnect } from '@/lib/services/frameio-tokens';

export async function GET() {
  return NextResponse.json({
    connected:   isConnected(),
    connectedAt: connectedAt(),
  });
}

export async function DELETE() {
  disconnect();
  return NextResponse.json({ ok: true });
}
