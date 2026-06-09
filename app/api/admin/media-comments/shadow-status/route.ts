/**
 * GET /api/admin/media-comments/shadow-status
 *
 * Admin-only visibility into the Phase 0 shadow-capture state for the
 * local-comments refactor (docs/local-comments-refactor-spec.md §12 Phase 0).
 *
 * Used to verify capture is working before Phase 1 swaps the UI's read path
 * over to media_comments. Returns counts (total + by source + by topology +
 * soft-deleted), recent samples, and per-project breakdown.
 *
 * Optional ?sample=N query param (default 10, max 100).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getMediaCommentShadowStatus } from '@/lib/store/media-comment-store';

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const url    = new URL(req.url);
  const sample = Math.min(100, Math.max(0, Number.parseInt(url.searchParams.get('sample') ?? '10', 10) || 10));

  try {
    const status = getMediaCommentShadowStatus(sample);
    return NextResponse.json({
      phase: 'Phase 0 — shadow capture',
      spec:  'docs/local-comments-refactor-spec.md',
      ...status,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
