'use client';

/**
 * AddToShareModal — put the chosen videos into an existing share (Media tab
 * right-click / batch bar → "Add to share…"). "Share…" is the one-click way to
 * make a new link; this is the way to grow one.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ShareSummary } from '@/lib/services/share-links';

interface Props {
  items:   Array<{ assetId: string; projectId: string }>;
  onClose: () => void;
  onAdded: (share: ShareSummary) => void;
}

export function AddToShareModal({ items, onClose, onAdded }: Readonly<Props>) {
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/share-links').then((r) => r.json())
      .then((d: { shares?: ShareSummary[] }) => setShares(d.shares ?? []))
      .catch(() => setShares([]));
  }, []);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (shares ?? []).filter((s) => !n || s.name.toLowerCase().includes(n));
  }, [shares, q]);

  async function add(s: ShareSummary) {
    setBusy(s.id);
    const res = await fetch(`/api/share-links/${s.id}/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
    });
    setBusy(null);
    if (res.ok) onAdded(s);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box shl-box" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add to share">
        <div className="modal-header"><h2 className="modal-title">Add {items.length} video{items.length === 1 ? '' : 's'} to…</h2></div>
        <input className="modal-input" autoFocus placeholder="Search shares" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search shares" />
        <div className="shm-picker-list">
          {shares === null ? <p className="modal-body-text">Loading…</p>
            : filtered.length === 0 ? <p className="modal-body-text">{shares.length ? 'No shares match.' : 'No shares yet — use Share… to make one.'}</p>
            : filtered.map((s) => (
              <button key={s.id} type="button" className="shl-row" disabled={!!busy} onClick={() => void add(s)}>
                <span>
                  <span className="shl-name">{s.name}</span>
                  <span className="shl-meta">
                    {s.videoCount} video{s.videoCount === 1 ? '' : 's'}
                    {s.caps.internal && <span className="shv-pill shv-pill--internal">LP Staff Only</span>}
                  </span>
                </span>
                <span />
                <span className="shm-item-sub">{busy === s.id ? 'Adding…' : ''}</span>
              </button>
            ))}
        </div>
        <div className="modal-actions"><button type="button" className="modal-btn-ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
