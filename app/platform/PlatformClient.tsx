'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PlatformPass, PassStatus } from '@/lib/store/platform-pass-store';
import { resolveBrand } from '@/lib/platform/tile-background';
import { ShareModal, shareUrl } from '@/components/share/ShareModal';
import type { ShareSummary } from '@/lib/services/share-links';

const STATUS_LABEL: Record<PassStatus, string> = {
  draft: 'Draft', composed: 'Composed', linked: 'Linked',
  enriched: 'Enriched', exported: 'Exported', synced: 'Synced',
};

function statusColor(s: PassStatus): string {
  switch (s) {
    case 'synced': return 'var(--success)';
    case 'exported': return 'var(--accent)';
    case 'enriched': case 'linked': return '#6fa8d8';
    default: return 'var(--muted-soft)';
  }
}

export function PlatformClient({ initialPasses }: { initialPasses: PlatformPass[] }) {
  const router = useRouter();
  const [passes, setPasses] = useState<PlatformPass[]>(initialPasses);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Shares: pass-backed ones light up their pass card; the rest are one-off
  // shares made from the Media tab, listed under "Other shares".
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [managing, setManaging] = useState<string | null>(null);
  const loadShares = useCallback(async () => {
    const res = await fetch('/api/share-links');
    if (res.ok) setShares(((await res.json()) as { shares?: ShareSummary[] }).shares ?? []);
  }, []);
  useEffect(() => { void loadShares(); }, [loadShares]);
  const sharedPassIds = new Set(shares.filter((x) => x.passId).map((x) => x.passId));
  const otherShares = shares.filter((x) => !x.passId);

  async function createPass() {
    if (!title.trim() || busy) return;
    setBusy(true);
    const res = await fetch('/api/platform/passes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    setBusy(false);
    if (res.ok) { const { pass } = await res.json(); router.push(`/platform/${pass.slug}`); }
  }

  async function deletePass(id: string) {
    await fetch(`/api/platform/passes/${id}`, { method: 'DELETE' });
    setPasses((ps) => ps.filter((p) => p.id !== id));
  }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '40px 24px 64px' }}>
      <style>{`@keyframes pfFadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, animation: 'pfFadeIn .6s ease both' }}>
        <h1 style={{ margin: 0, fontSize: 48, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-strong)', lineHeight: 1 }}>Platform</h1>
        {!creating
          ? <button onClick={() => setCreating(true)} style={primaryBtn}>+ Design New Pass</button>
          : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createPass(); if (e.key === 'Escape') { setCreating(false); setTitle(''); } }}
                placeholder="New pass title…"
                style={{ ...inputStyle, width: 280 }}
              />
              <button onClick={createPass} disabled={!title.trim() || busy} style={{ ...primaryBtn, opacity: !title.trim() || busy ? 0.5 : 1 }}>Create</button>
              <button onClick={() => { setCreating(false); setTitle(''); }} style={ghostBtn}>Cancel</button>
            </div>
          )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14, marginTop: 40, animation: 'pfFadeIn .6s ease both', animationDelay: '.08s' }}>
        {passes.map((p) => {
          const brand = resolveBrand(p.brand, p.brandConfig);
          return (
            <button key={p.id}
              onClick={() => router.push(`/platform/${p.slug}`)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: Math.min(e.clientX, window.innerWidth - 184), y: Math.min(e.clientY, window.innerHeight - 120), id: p.id }); }}
              style={passCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: brand.swatch }} />
                <span style={{ fontSize: 11, color: 'var(--muted-soft)' }}>{brand.name}</span>
                {sharedPassIds.has(p.id) && <span title="Shared" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />}
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: statusColor(p.status) }}>{STATUS_LABEL[p.status]}</span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-strong)', letterSpacing: '-0.01em', lineHeight: 1.25 }}>{p.title}</div>
              <div style={{ fontSize: 11, color: 'var(--muted-soft)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                updated {new Date(p.updatedAt).toLocaleDateString()}
              </div>
            </button>
          );
        })}
      </div>

      {otherShares.length > 0 && (
        <div style={{ marginTop: 44, animation: 'pfFadeIn .6s ease both', animationDelay: '.12s' }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted-soft)' }}>Other shares</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {otherShares.map((x) => (
              <div key={x.id} className="shl-row" role="button" tabIndex={0}
                onClick={() => setManaging(x.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') setManaging(x.id); }}>
                <span>
                  <span className="shl-name">{x.name}</span>
                  <span className="shl-meta">
                    {x.videoCount} video{x.videoCount === 1 ? '' : 's'}
                    {x.caps.internal && <span className="shv-pill shv-pill--internal">LP Staff Only</span>}
                  </span>
                </span>
                <button type="button" className="shm-icon" title="Copy link" aria-label="Copy link"
                  onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(shareUrl(x.token)).catch(() => {}); }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>
                </button>
                <a className="shm-open" href={`/s/${x.token}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a>
              </div>
            ))}
          </div>
        </div>
      )}
      {managing && <ShareModal shareId={managing} onClose={() => { setManaging(null); void loadShares(); }} onChanged={() => void loadShares()} />}

      {passes.length === 0 && !creating && (
        <div style={{ marginTop: 40, padding: '48px 24px', textAlign: 'center', color: 'var(--muted-soft)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          No passes yet. Click <b style={{ color: 'var(--muted)' }}>Design New Pass</b> to start composing one.
        </div>
      )}

      {menu && (() => {
        const mp = passes.find((p) => p.id === menu.id);
        return (
          <>
            <div onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
            <div style={{ ...ctxMenu, left: menu.x, top: menu.y }}>
              <CtxItem onClick={() => { if (mp) router.push(`/platform/${mp.slug}`); setMenu(null); }}>Open</CtxItem>
              <div style={{ height: 1, background: 'var(--line)', margin: '4px 6px' }} />
              <CtxItem danger onClick={() => { deletePass(menu.id); setMenu(null); }}>Delete pass</CtxItem>
            </div>
          </>
        );
      })()}
    </div>
  );
}

function CtxItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...ctxItem, background: hover ? 'var(--surface-hover)' : 'transparent', color: danger ? 'var(--warning)' : 'var(--text)' }}>
      {children}
    </button>
  );
}

const primaryBtn: React.CSSProperties = {
  background: 'var(--accent)', color: '#1a1206', border: 'none', borderRadius: 9,
  padding: '9px 16px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
};
const ghostBtn: React.CSSProperties = {
  background: 'transparent', color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 9,
  padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const inputStyle: React.CSSProperties = {
  background: 'var(--surface-inset)', border: '1px solid var(--line)', color: 'var(--text)',
  borderRadius: 8, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit', outline: 'none',
};
const passCard: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left',
  background: 'var(--surface-raised)', border: '1px solid var(--line)', borderRadius: 14,
  padding: 16, cursor: 'pointer', color: 'var(--text)', minHeight: 104,
};
const ctxMenu: React.CSSProperties = {
  position: 'fixed', zIndex: 61, minWidth: 168, background: 'var(--surface-2)',
  border: '1px solid var(--line-strong)', borderRadius: 10, padding: 5,
  display: 'flex', flexDirection: 'column', gap: 1, boxShadow: 'var(--shadow-lg)',
};
const ctxItem: React.CSSProperties = {
  textAlign: 'left', background: 'transparent', border: 0, color: 'var(--text)',
  fontSize: 13, fontWeight: 500, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', width: '100%',
};
