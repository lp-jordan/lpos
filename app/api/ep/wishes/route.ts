import { NextRequest, NextResponse } from 'next/server';
import { requireEpToken } from '@/lib/services/ep-auth';
import { getWishStore } from '@/lib/services/container';

/**
 * GET /api/ep/wishes
 *
 * Shared feature-request / wish list, read by EditPanel so every instance shows
 * the same list with live Open/Done status. Returns the full set (dashboard +
 * editpanel origin); the EditPanel UI can badge by `source`.
 */
export async function GET(req: NextRequest) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const wishes = getWishStore().getAll();
    return NextResponse.json({ wishes });
  } catch {
    return NextResponse.json({ wishes: [] });
  }
}

/**
 * POST /api/ep/wishes
 *
 * An editor submits a feature request from EditPanel. Attribution comes from the
 * X-EP-Token (the linked LPOS user); `instance` (machine/display name) is carried
 * in the body so the dashboard Wish List can show which machine raised it. Origin
 * is always stamped 'editpanel'.
 */
export async function POST(req: NextRequest) {
  const auth = requireEpToken(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({})) as {
    title?: string;
    description?: string;
    instance?: string;
  };

  if (!body.title?.trim()) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const wish = getWishStore().create({
    title: body.title,
    description: body.description,
    submittedBy: auth.user.id,
    submittedByName: auth.user.name || auth.user.email || 'EditPanel user',
    source: 'editpanel',
    sourceInstance: body.instance,
  });

  return NextResponse.json({ wish }, { status: 201 });
}
