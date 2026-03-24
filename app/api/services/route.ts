import { NextResponse } from 'next/server';
import { getRegistry } from '@/lib/services/container';
import { getRuntimeDependencyReport } from '@/lib/services/runtime-dependencies';

export async function GET() {
  try {
    const services = getRegistry().list();
    const runtime = getRuntimeDependencyReport();
    return NextResponse.json({ ok: true, services, runtime });
  } catch {
    // Registry not initialized — server.ts not in use (e.g. next dev directly)
    return NextResponse.json({ ok: false, services: [], runtime: getRuntimeDependencyReport() });
  }
}
