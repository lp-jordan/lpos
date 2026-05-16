/**
 * GET /api/prospects/similar?company=<name>
 *
 * Used by NewProjectModal: when a user types a new clientName, we check
 * whether the People CRM already has a similar entry so we can warn before
 * creating a duplicate. Returns up to 5 candidates ordered by match strength.
 *
 * Auth: any signed-in user (not Prospects-restricted — this is a duplicate-
 * detection guard, not a People data exposure path). Only company names and
 * prospect IDs are returned; no contact info, revenue, etc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getProspectStore } from '@/lib/services/container';
import { findSimilarMatches } from '@/lib/utils/fuzzy-match';

const MAX_RESULTS = 5;

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'user');
  if (deny) return deny;

  const company = req.nextUrl.searchParams.get('company')?.trim() ?? '';
  if (!company) {
    return NextResponse.json({ matches: [] });
  }

  const all = getProspectStore().getAll({ includeArchived: false });
  const byCompany = new Map<string, { prospectId: string; status: string }>();
  for (const p of all) {
    byCompany.set(p.company, { prospectId: p.prospectId, status: p.status });
  }

  const matches = findSimilarMatches(company, Array.from(byCompany.keys()))
    .slice(0, MAX_RESULTS)
    .map((m) => {
      const info = byCompany.get(m.candidate)!;
      return {
        prospectId: info.prospectId,
        company: m.candidate,
        status: info.status,
        reason: m.reason,
        distance: m.distance,
      };
    });

  return NextResponse.json({ matches });
}
