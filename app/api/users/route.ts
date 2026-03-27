import { NextResponse } from 'next/server';
import { getAllUsers, toUserSummary } from '@/lib/store/user-store';

export async function GET() {
  const users = getAllUsers().map(toUserSummary).filter(Boolean);
  return NextResponse.json({ users });
}
