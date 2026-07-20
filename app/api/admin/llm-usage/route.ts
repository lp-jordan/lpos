import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getLlmUsageReport } from '@/lib/store/llm-usage-store';

/**
 * Admin API for the "AI Usage & Cost" card. Returns exact token usage + computed
 * cost (from each Claude call's real usage block) aggregated over a time window.
 */

function rangeToWindow(range: string): { since: string; until: string } {
  const now = new Date();
  // Include the current moment (small forward pad so "now" rows are counted).
  const until = new Date(now.getTime() + 1000).toISOString();
  let since: Date;
  switch (range) {
    case '7d':  since = new Date(now.getTime() - 7 * 24 * 3600 * 1000); break;
    case '30d': since = new Date(now.getTime() - 30 * 24 * 3600 * 1000); break;
    case 'all': since = new Date('2000-01-01T00:00:00Z'); break;
    case 'mtd':
    default:    since = new Date(now.getFullYear(), now.getMonth(), 1); break; // month-to-date (local month)
  }
  return { since: since.toISOString(), until };
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const range = req.nextUrl.searchParams.get('range') ?? 'mtd';
  const { since, until } = rangeToWindow(range);
  const report = getLlmUsageReport(since, until);
  return NextResponse.json({ range, ...report });
}
