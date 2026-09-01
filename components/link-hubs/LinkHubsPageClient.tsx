'use client';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import type { HubSummary, OwnerType } from './types';
import { NewHubModal } from './NewHubModal';
import { ManageHubModal } from './ManageHubModal';

const OWNER_COLORS: Record<OwnerType, { fg: string; bg: string; bd: string }> = {
  client: { fg: '#74a9e2', bg: 'rgba(116,169,226,0.15)', bd: 'rgba(116,169,226,0.3)' },
  person: { fg: 'var(--muted, #c4b8a8)', bg: 'var(--surface-3, rgba(31,43,55,0.9))', bd: 'var(--line, rgba(113,131,150,0.2))' },
  leaderpass: { fg: 'var(--accent-strong, #f2cf91)', bg: 'var(--accent-soft, rgba(219,175,95,0.18))', bd: 'rgba(219,175,95,0.34)' },
};

function OwnerBadge({ hub }: { hub: HubSummary }) {
  const c = OWNER_COLORS[hub.owner_type];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 100,
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.bd}`,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.fg }} />
      {hub.owner_label}
    </span>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function LinkHubsPageClient({ initialHubs }: { initialHubs: HubSummary[] }) {
  const [hubs, setHubs] = useState<HubSummary[]>(initialHubs);
  const [showNew, setShowNew] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/link-hubs');
      if (!res.ok) return;
      const data = (await res.json()) as { hubs?: HubSummary[] };
      setHubs(data.hubs ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '24px 22px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: 14 }}>
        <Link href="/projects" style={{ color: 'var(--muted-soft, #9d9287)', textDecoration: 'none' }}>Projects</Link>
        <span style={{ color: 'var(--muted-soft, #9d9287)' }}>›</span>
        <span style={{ color: 'var(--text-strong, #fff9ef)', fontWeight: 700 }}>Link Hubs</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--text-strong, #fff9ef)' }}>
          Link Hubs{' '}
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted-soft, #9d9287)' }}>({hubs.length})</span>
        </h1>
        <button type="button" className="proj-new-btn" onClick={() => setShowNew(true)}>+ New hub</button>
      </div>

      <div style={{ border: '1px solid var(--line, rgba(113,131,150,0.2))', borderRadius: 12, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 78px 78px 120px 96px',
            gap: 12,
            padding: '10px 16px',
            background: 'var(--surface-inset, rgba(11,16,22,0.5))',
            fontSize: 11,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--muted-soft, #9d9287)',
            fontWeight: 600,
          }}
        >
          <span>Hub</span>
          <span>Videos</span>
          <span>Access</span>
          <span>Updated</span>
          <span />
        </div>

        {hubs.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--muted-soft, #9d9287)' }}>
            No link hubs yet. Create one to start delivering finished videos.
          </div>
        ) : (
          hubs.map((h) => (
            <div
              key={h.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 78px 78px 120px 96px',
                gap: 12,
                alignItems: 'center',
                padding: '13px 16px',
                borderTop: '1px solid var(--line, rgba(113,131,150,0.2))',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-strong, #fff9ef)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.name}
                </div>
                <div style={{ marginTop: 4 }}>
                  <OwnerBadge hub={h} />
                </div>
              </div>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text, #f4eee2)' }}>{h.video_count}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text, #f4eee2)' }}>{h.access_count}</span>
              <span style={{ color: 'var(--muted-soft, #9d9287)', fontSize: 12.5 }}>{fmtDate(h.updated_at)}</span>
              <span style={{ justifySelf: 'end' }}>
                <button
                  type="button"
                  onClick={() => setManageId(h.id)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 7,
                    fontWeight: 600,
                    fontSize: 12.5,
                    border: '1px solid var(--line, rgba(113,131,150,0.2))',
                    background: 'none',
                    color: 'var(--muted, #c4b8a8)',
                    cursor: 'pointer',
                  }}
                >
                  Manage
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {showNew && (
        <NewHubModal
          onClose={() => setShowNew(false)}
          onCreated={(hubId) => {
            setShowNew(false);
            void refresh();
            setManageId(hubId);
          }}
        />
      )}
      {manageId && (
        <ManageHubModal hubId={manageId} onClose={() => setManageId(null)} onSaved={() => void refresh()} />
      )}
    </div>
  );
}
