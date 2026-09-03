'use client';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import type { HubSummary } from './types';
import { NewHubModal } from './NewHubModal';
import { ManageHubModal } from './ManageHubModal';
import { useContextMenu } from '@/contexts/ContextMenuContext';
import { ConfirmModal } from '@/components/shared/ConfirmModal';

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
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { openMenu } = useContextMenu();

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

  async function doDelete(id: string) {
    const res = await fetch(`/api/link-hubs/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete hub');
    await refresh();
  }

  function openHubMenu(e: React.MouseEvent, h: HubSummary) {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      {
        type: 'item' as const,
        label: 'Manage…',
        icon: (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        ),
        onClick: () => setManageId(h.id),
      },
      { type: 'separator' as const },
      {
        type: 'item' as const,
        label: 'Delete hub',
        danger: true,
        icon: (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
          </svg>
        ),
        onClick: () => {
          setDeleteError(null);
          setConfirmDelete({ id: h.id, name: h.name });
        },
      },
    ]);
  }

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
              onContextMenu={(e) => openHubMenu(e, h)}
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
                <div style={{ marginTop: 3, fontSize: 12, color: 'var(--muted-soft, #9d9287)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.owner_label}
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

      <p style={{ marginTop: 10, fontSize: 12, color: 'var(--muted-soft, #9d9287)' }}>
        Right-click a hub to manage or delete it.
      </p>

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
      {confirmDelete && (
        <ConfirmModal
          title="Delete link hub?"
          body={`“${confirmDelete.name}” will be removed — its videos and login access, and its share links will stop working. This can’t be undone.`}
          confirmLabel="Delete hub"
          danger
          error={deleteError}
          onConfirm={async () => {
            try {
              await doDelete(confirmDelete.id);
              setConfirmDelete(null);
            } catch (err) {
              setDeleteError((err as Error).message);
            }
          }}
          onClose={() => {
            setConfirmDelete(null);
            setDeleteError(null);
          }}
        />
      )}
    </div>
  );
}
