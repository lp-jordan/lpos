import { NextResponse } from 'next/server';
import { getClientStats } from '@/lib/services/client-stats';

export async function GET() {
  try {
    return NextResponse.json({ stats: getClientStats() });
  } catch {
    return NextResponse.json({ stats: {} });
  }
}
