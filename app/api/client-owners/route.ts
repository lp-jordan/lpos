import { NextResponse } from 'next/server';
import { getClientOwnerStore } from '@/lib/services/container';

export async function GET() {
  return NextResponse.json({ owners: getClientOwnerStore().getAll() });
}
