'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Prospect, ProspectStatus } from '@/lib/models/prospect';
import type { Client } from '@/lib/store/client-store';
import type { UserSummary } from '@/lib/models/user';
import { OwnerAvatar } from '@/components/projects/OwnerAvatar';

// ── Helpers ───────────────────────────────────────────────────────────────────

function compactCurrency(v: number): string {
  if (v === 0) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000)      return `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`;
  return `$${v.toLocaleString()}`;
}

function relativeDate(iso: string): string {
  try {
    const diff  = Date.now() - new Date(iso).getTime();
    const days  = Math.floor(diff / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30)  return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 8)  return `${weeks}w ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  } catch { return ''; }
}

const STATUS_STYLE: Record<ProspectStatus, { bg: string; border: string; color: string }> = {
  prospect: { bg: 'rgba(91,141,217,0.15)',  border: '#5b8dd9', color: '#5b8dd9' },
  active:   { bg: 'rgba(90,185,90,0.15)',   border: '#5ab95a', color: '#5ab95a' },
  inactive: { bg: 'rgba(120,120,120,0.15)', border: '#888',    color: '#888'    },
};
const STATUS_LABELS: Record<ProspectStatus, string> = {
  prospect: 'Prospect', active: 'Active', inactive: 'Inactive',
};

function StatusBadge({ status }: { status: ProspectStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{
      display: 'inline-block', padding: '0.2rem 0.55rem', borderRadius: '999px',
      border: `1px solid ${s.border}`, backgroundColor: s.bg, color: s.color,
      fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em', whiteSpace: 'nowrap',
    }}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function AvatarStrip({ userIds, allUsers }: { userIds: string[]; allUsers: UserSummary[] }) {
  const users = userIds.map((id) => allUsers.find((u) => u.id === id)).filter(Boolean) as UserSummary[];
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {users.slice(0, 4).map((u) => <OwnerAvatar key={u.id} user={u} size={22} />)}
      {users.length > 4 && (
        <span style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: '22px' }}>+{users.length - 4}</span>
      )}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  client:      Client;
  engagements: Prospect[];
  accessUsers: UserSummary[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OrgDetailClient({ client, engagements, accessUsers }: Props) {
  const router = useRouter();

  const totalMRR      = engagements.reduce((s, p) => s + (p.monthlyLpRevenue ?? 0) + (p.monthlyLpTechRevenue ?? 0), 0);
  const totalARR      = totalMRR * 12;
  const activeCount   = engagements.filter((p) => p.status === 'active').length;
  const inactiveCount = engagements.filter((p) => p.status === 'inactive').length;

  return (
    <div className="page-stack">

      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 20, borderBottom: '1px solid var(--line)' }}>
        <Link
          href="/people"
          style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)', fontSize: '0.82rem', textDecoration: 'none', width: 'fit-content' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          People
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-strong)' }}>
            {client.name}
          </h1>
          <span style={{
            fontSize: '0.72rem', color: 'var(--muted)', background: 'rgba(255,255,255,0.06)',
            border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px',
          }}>
            Organisation
          </span>
        </div>
      </div>

      {/* Stats strip */}
      {engagements.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap',
          padding: '0.55rem 0.9rem', borderRadius: 8,
          background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)',
          fontSize: '0.8rem',
        }}>
          <span style={{ color: 'var(--muted-soft)' }}>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>{engagements.length}</span>
            {' '}engagement{engagements.length !== 1 ? 's' : ''}
          </span>
          {activeCount > 0 && (
            <>
              <span style={{ color: 'var(--line-strong)' }}>|</span>
              <span style={{ color: 'var(--muted-soft)' }}>
                <span style={{ color: '#5ab95a', fontWeight: 600 }}>{activeCount}</span> active
                {inactiveCount > 0 && (
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>· {inactiveCount} inactive</span>
                )}
              </span>
            </>
          )}
          {totalMRR > 0 && (
            <>
              <span style={{ color: 'var(--line-strong)' }}>|</span>
              <span style={{ color: 'var(--muted-soft)' }}>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{compactCurrency(totalMRR)}</span>/mo
                <span style={{ color: 'var(--muted)', marginLeft: 6 }}>· {compactCurrency(totalARR)}/yr</span>
              </span>
            </>
          )}
        </div>
      )}

      {/* Engagements */}
      <div>
        <p style={{ margin: '0 0 12px', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted-soft)' }}>
          Engagements
        </p>

        {engagements.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>No engagements yet.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {engagements.map((p) => {
            const mrr = (p.monthlyLpRevenue ?? 0) + (p.monthlyLpTechRevenue ?? 0);
            return (
              <div
                key={p.prospectId}
                onClick={() => router.push(`/people/${p.prospectId}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
                  background: 'var(--surface-1)', border: '1px solid var(--line)',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
              >
                <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-strong)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.company}
                </span>
                <StatusBadge status={p.status} />
                {mrr > 0 && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted-soft)', whiteSpace: 'nowrap' }}>
                    {compactCurrency(mrr)}/mo
                  </span>
                )}
                <AvatarStrip userIds={p.assignedTo} allUsers={accessUsers} />
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {relativeDate(p.updatedAt)}
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: 'var(--muted)' }}>
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
