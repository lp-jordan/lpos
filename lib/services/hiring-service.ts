/**
 * Talks to the `lpos-apply` Railway service, which holds ALL hiring data.
 * LPOS stores none of it — only the access grants that decide who may look.
 *
 * Same shape as the lpos-ingest integration (`INGEST_BASE_URL` +
 * `INGEST_API_KEY`, see lib/services/delivery-upload.ts).
 *
 * Accepted consequence, per the plan: if Railway is unreachable the Hiring tab
 * errors rather than showing stale data. Same failure mode as the existing
 * delivery/ingest panels.
 */

export const HIRING_URL     = (process.env.HIRING_BASE_URL ?? '').replace(/\/$/, '');
export const HIRING_API_KEY = process.env.HIRING_API_KEY ?? '';

export function hiringConfigured(): boolean {
  return Boolean(HIRING_URL && HIRING_API_KEY);
}

export interface HiringInvite {
  token: string;
  candidate_name: string;
  candidate_email: string | null;
  role_label: string | null;
  status: 'sent' | 'started' | 'completed' | 'expired';
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  revoked: boolean;
  intro_dwell_ms: number;
  answered: number;
  question_count: number;
}

export interface HiringQuestionnaire {
  id: number;
  name: string;
  version: number;
  published: boolean;
  created_at: string;
  question_count: number;
}

class HiringError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!hiringConfigured()) {
    throw new HiringError('Hiring service is not configured (HIRING_BASE_URL / HIRING_API_KEY).', 503);
  }

  let res: Response;
  try {
    res = await fetch(`${HIRING_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': HIRING_API_KEY,
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
  } catch {
    throw new HiringError('Could not reach the hiring service.', 502);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new HiringError(body.error ?? `Hiring service returned ${res.status}.`, res.status);
  }
  return res.json() as Promise<T>;
}

export function listInvites(): Promise<HiringInvite[]> {
  return call<HiringInvite[]>('/api/invites');
}

export function listQuestionnaires(): Promise<HiringQuestionnaire[]> {
  return call<HiringQuestionnaire[]>('/api/questionnaires');
}

export function createInvite(input: {
  questionnaireId: number;
  candidateName: string;
  candidateEmail?: string;
  roleLabel?: string;
  createdBy?: string;
  expiresAt?: string;
}): Promise<{ token: string; url: string }> {
  return call('/api/invites', { method: 'POST', body: JSON.stringify(input) });
}

export { HiringError };
