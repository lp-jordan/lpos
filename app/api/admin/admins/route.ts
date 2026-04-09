/**
 * GET  /api/admin/admins  — list all admin emails
 * POST /api/admin/admins  — add an admin email  { email: string }
 * DELETE /api/admin/admins — remove an admin email  { email: string }
 *
 * All methods require admin role. The bootstrap admin cannot be removed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getAdmins, addAdmin, removeAdmin, BOOTSTRAP_ADMIN } from '@/lib/store/admin-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  return NextResponse.json({ admins: getAdmins(), bootstrapAdmin: BOOTSTRAP_ADMIN });
}

export async function POST(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json().catch(() => ({})) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }

  try {
    const admins = addAdmin(email);
    return NextResponse.json({ admins });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const body = await req.json().catch(() => ({})) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'An email address is required.' }, { status: 400 });
  }

  try {
    const admins = removeAdmin(email);
    return NextResponse.json({ admins });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
