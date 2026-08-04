'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PlatformPass, PassStatus } from '@/lib/store/platform-pass-store';
import { resolveBrand } from '@/lib/platform/tile-background';

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
  const [passes] = useState<PlatformPass[]>(initialPasses);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function createPass() {
    if (!title.trim() || busy) return;
    setBusy(true);
    const res = await fetch('/api/platform/passes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    setBusy(false);
    if (res.ok) { const { pass } = await res.json(); router.push(`/platform/${pass.id}`); }
  }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '40px 24px 64px' }}>
      <style>{`@keyframes pfFadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, animation: 'pfFadeIn .6s ease both' }}>
        <h1 style={{ margin: 0, fontSize: 52, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-strong)', lineHeight: 1 }}>PLATFORM</h1>
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
            <button key={p.id} onClick={() => router.push(`/platform/${p.id}`)} style={passCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: brand.swatch }} />
                <span style={{ fontSize: 11, color: 'var(--muted-soft)' }}>{brand.name}</span>
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

      {passes.length === 0 && !creating && (
        <div style={{ marginTop: 40, padding: '48px 24px', textAlign: 'center', color: 'var(--muted-soft)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          No passes yet. Click <b style={{ color: 'var(--muted)' }}>Design New Pass</b> to start composing one.
        </div>
      )}
    </div>
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
