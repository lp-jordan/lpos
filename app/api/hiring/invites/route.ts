import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/services/api-auth';
import { requireHiringAccess } from '@/lib/services/require-hiring-access';
import { listInvites, createInvite, HiringError } from '@/lib/services/hiring-service';
import { getUserById } from '@/lib/store/user-store';

export async function GET(req: NextRequest) {
  const deny = await requireHiringAccess(req);
  if (deny) return deny;

  try {
    const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1';
    return NextResponse.json({ invites: await listInvites(includeArchived) });
  } catch (err) {
    const e = err as HiringError;
    return NextResponse.json({ error: e.message }, { status: e.status ?? 500 });
  }
}

export async function POST(req: NextRequest) {
  const deny = await requireHiringAccess(req);
  if (deny) return deny;

  const session = await getSession(req);
  const body = await req.json() as {
    questionnaireId?: unknown;
    candidateName?: unknown;
    candidateEmail?: unknown;
    roleLabel?: unknown;
    expiresAt?: unknown;
  };

  const questionnaireId = Number(body.questionnaireId);
  const candidateName   = typeof body.candidateName === 'string' ? body.candidateName.trim() : '';

  if (!Number.isFinite(questionnaireId) || questionnaireId <= 0) {
    return NextResponse.json({ error: 'Choose an assessment.' }, { status: 400 });
  }
  if (!candidateName) {
    return NextResponse.json({ error: "The candidate's name is required." }, { status: 400 });
  }

  try {
    const invite = await createInvite({
      questionnaireId,
      candidateName,
      candidateEmail: typeof body.candidateEmail === 'string' && body.candidateEmail.trim()
        ? body.candidateEmail.trim() : undefined,
      roleLabel: typeof body.roleLabel === 'string' && body.roleLabel.trim()
        ? body.roleLabel.trim() : undefined,
      expiresAt: typeof body.expiresAt === 'string' && body.expiresAt ? body.expiresAt : undefined,
      createdBy: (session ? getUserById(session.userId)?.email : null) ?? session?.userId,
    });
    return NextResponse.json(invite);
  } catch (err) {
    const e = err as HiringError;
    return NextResponse.json({ error: e.message }, { status: e.status ?? 500 });
  }
}
