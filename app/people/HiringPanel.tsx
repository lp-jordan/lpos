'use client';

import { useCallback, useEffect, useState } from 'react';
import { HiringReport } from './HiringReport';

/**
 * The Hiring tab on /people.
 *
 * Deliberately not a new top-level nav item: hiring is episodic — a few weeks a
 * year — so permanent navbar chrome is a poor trade, and /people already has
 * the granted-access model this needs.
 *
 * All data lives in the lpos-apply Railway service. If it is unreachable this
 * errors rather than showing stale rows, which is the same failure mode as the
 * delivery and ingest panels.
 */

interface Invite {
  token: string;
  candidate_name: string;
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
  archived: boolean;
  /** Built by lpos-apply from its own PUBLIC_BASE_URL. */
  url: string | null;
}

interface Questionnaire {
  id: number;
  name: string;
  version: number;
  published: boolean;
  question_count: number;
}

const STATUS_COLOR: Record<Invite['status'], string> = {
  sent:      '#777',
  started:   '#f59e0b',
  completed: '#5ab95a',
  expired:   '#666',
};

function statusLabel(inv: Invite): string {
  if (inv.revoked) return 'Revoked';
  if (inv.status === 'completed') return 'Complete';
  if (inv.status === 'started') return `Q${Math.min(inv.answered + 1, inv.question_count)} of ${inv.question_count}`;
  if (inv.status === 'expired') return 'Expired';
  return 'Not started';
}

/** Total elapsed from Begin to submit — the headline number on the report. */
function totalTime(inv: Invite): string {
  if (!inv.started_at) return '—';
  const end = inv.completed_at ? new Date(inv.completed_at) : new Date();
  const ms  = end.getTime() - new Date(inv.started_at).getTime();
  if (ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function HiringPanel() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [copied, setCopied]   = useState<string | null>(null);
  const [openToken, setOpenToken] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res  = await fetch(`/api/hiring/invites${showArchived ? '?includeArchived=1' : ''}`);
      const data = await res.json() as { invites?: Invite[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to load candidates.');
      setInvites(data.invites ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { void load(); }, [load]);

  async function setArchived(invite: Invite, archived: boolean) {
    setBusy(invite.token);
    try {
      const res = await fetch(`/api/hiring/invites/${invite.token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // The candidate URL is served by lpos-apply, not LPOS, so it comes back from
  // the API rather than being reconstructed against the dashboard's own host.
  async function copyLink(invite: Invite) {
    if (!invite.url) {
      setError('That invite has no link yet — the hiring service did not report one.');
      return;
    }
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(invite.token);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError('Could not copy to clipboard.');
    }
  }

  if (openToken) {
    return <HiringReport token={openToken} onClose={() => { setOpenToken(null); void load(); }} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted-soft)' }}>
          {invites.length > 0
            ? `${invites.length} candidate${invites.length === 1 ? '' : 's'}`
            : ''}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            style={{
              padding: '0.25rem 0.6rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer',
              border: '1px solid var(--color-border,#444)',
              background: showArchived ? 'var(--accent-soft)' : 'var(--color-input-bg,#1a1a1a)',
              color: showArchived ? 'var(--accent-strong)' : 'var(--muted)',
            }}
          >
            {showArchived ? 'Hiding archived' : 'Show archived'}
          </button>
          <button type="button" className="proj-new-btn" onClick={() => setShowNew(true)}>
            + New invite
          </button>
        </div>
      </div>

      {loading && <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>Loading…</p>}

      {error && (
        <div style={{
          padding: '0.75rem 1rem', borderRadius: 8,
          border: '1px solid rgba(229,85,85,0.4)', background: 'rgba(229,85,85,0.08)',
          color: 'var(--color-error, #e55)', fontSize: '0.85rem',
        }}>
          {error}
          <button
            type="button"
            onClick={() => void load()}
            style={{
              marginLeft: '0.75rem', background: 'none', border: 'none',
              color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.85rem',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && invites.length === 0 && (
        <p style={{ color: 'var(--muted-soft)', fontSize: '0.875rem', padding: '2rem 0', textAlign: 'center' }}>
          No candidates yet. Create an invite to send an assessment.
        </p>
      )}

      {!loading && invites.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {invites.map((inv) => (
            <div
              key={inv.token}
              style={{
                display: 'flex', alignItems: 'center', gap: '1rem',
                padding: '0.7rem 0.9rem',
                borderBottom: '1px solid var(--line)',
                borderLeft: `3px solid ${inv.revoked ? '#666' : STATUS_COLOR[inv.status]}`,
                fontSize: '0.875rem',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <button
                  type="button"
                  onClick={() => setOpenToken(inv.token)}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    font: 'inherit', fontWeight: 500, color: 'inherit', textAlign: 'left',
                  }}
                  title="Open the candidate report"
                >
                  {inv.candidate_name}
                </button>
                <div style={{ color: 'var(--muted-soft)', fontSize: '0.78rem' }}>
                  {new Date(inv.created_at).toLocaleDateString()}
                  {inv.role_label && <span> · {inv.role_label}</span>}
                </div>
              </div>

              <div style={{ width: 110, color: 'var(--muted)', fontSize: '0.8rem' }}>
                {statusLabel(inv)}
              </div>

              <div style={{ width: 70, color: 'var(--muted)', fontSize: '0.8rem' }} title="Total time from Begin">
                {totalTime(inv)}
              </div>

              <button
                type="button"
                onClick={() => void copyLink(inv)}
                title="Copy the candidate link"
                style={{
                  padding: '0.25rem 0.6rem', borderRadius: 6, fontSize: '0.78rem',
                  border: '1px solid var(--color-border,#444)',
                  background: 'var(--color-input-bg,#1a1a1a)',
                  color: copied === inv.token ? 'var(--accent-strong)' : 'var(--muted)',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {copied === inv.token ? 'Copied' : 'Copy link'}
              </button>

              <button
                type="button"
                disabled={busy === inv.token}
                onClick={() => void setArchived(inv, !inv.archived)}
                title={inv.archived ? 'Restore to the list' : 'Archive — hides the row, keeps the answers'}
                style={{
                  padding: '0.25rem 0.6rem', borderRadius: 6, fontSize: '0.78rem',
                  border: '1px solid var(--color-border,#444)',
                  background: 'var(--color-input-bg,#1a1a1a)',
                  color: 'var(--muted-soft)', cursor: 'pointer', whiteSpace: 'nowrap',
                  opacity: busy === inv.token ? 0.4 : 1,
                }}
              >
                {inv.archived ? 'Restore' : 'Archive'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <NewInviteModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); void load(); }}
        />
      )}
    </div>
  );
}

function NewInviteModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [questionnaires, setQuestionnaires] = useState<Questionnaire[]>([]);
  const [questionnaireId, setQuestionnaireId] = useState('');
  const [name, setName]   = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res  = await fetch('/api/hiring/questionnaires');
        const data = await res.json() as { questionnaires?: Questionnaire[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Failed to load assessments.');
        const list = data.questionnaires ?? [];
        setQuestionnaires(list);
        const published = list.find((q) => q.published) ?? list[0];
        if (published) setQuestionnaireId(String(published.id));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res  = await fetch('/api/hiring/invites', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ questionnaireId, candidateName: name }),
      });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create the invite.');
      setCreated({ url: data.url ?? '' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 100%)', borderRadius: 10, padding: '1.25rem',
          background: 'var(--color-card-bg, #161616)', border: '1px solid var(--line)',
        }}
      >
        <h3 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>
          {created ? 'Invite created' : 'New candidate invite'}
        </h3>

        {created ? (
          <>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: '0 0 0.5rem' }}>
              Send this link to the candidate. It stays on their row, so it never needs regenerating.
            </p>
            <input
              readOnly
              value={created.url}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                width: '100%', padding: '0.5rem 0.75rem', borderRadius: 6,
                border: '1px solid var(--color-border,#444)',
                background: 'var(--color-input-bg,#1a1a1a)', color: 'inherit',
                fontSize: '0.82rem', fontFamily: 'ui-monospace, monospace',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" className="storage-settings-primary" onClick={onCreated}>Done</button>
            </div>
          </>
        ) : (
          <>
            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.3rem' }}>
              Assessment
            </label>
            <select
              value={questionnaireId}
              onChange={(e) => setQuestionnaireId(e.target.value)}
              style={{
                width: '100%', padding: '0.45rem 0.75rem', borderRadius: 6, marginBottom: '0.85rem',
                border: '1px solid var(--color-border,#444)',
                background: 'var(--color-input-bg,#1a1a1a)', color: 'inherit', fontSize: '0.875rem',
              }}
            >
              {questionnaires.length === 0 && <option value="">No assessments seeded</option>}
              {questionnaires.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name} (v{q.version}, {q.question_count} questions){q.published ? '' : ' — draft'}
                </option>
              ))}
            </select>

            <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.3rem' }}>
              Candidate name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              style={{
                width: '100%', padding: '0.45rem 0.75rem', borderRadius: 6,
                border: '1px solid var(--color-border,#444)',
                background: 'var(--color-input-bg,#1a1a1a)', color: 'inherit', fontSize: '0.875rem',
              }}
            />

            {error && (
              <p style={{ color: 'var(--color-error,#e55)', fontSize: '0.8rem', marginTop: '0.6rem' }}>{error}</p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.1rem' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '0.4rem 0.9rem', borderRadius: 6, fontSize: '0.85rem',
                  border: '1px solid var(--color-border,#444)', background: 'transparent',
                  color: 'var(--muted)', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="storage-settings-primary"
                onClick={() => void submit()}
                disabled={saving || !name.trim() || !questionnaireId}
              >
                {saving ? 'Creating…' : 'Create invite'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
