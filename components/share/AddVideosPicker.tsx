'use client';

/**
 * AddVideosPicker — pick videos from any project to add to a share. Searches
 * name, Platform tile title, project and client; shows the title the share
 * will display (the tile title when there is one).
 */

import { useEffect, useMemo, useState } from 'react';
import type { ShareAssetOption } from '@/lib/services/share-links';

interface Props {
  /** Videos already in the share — shown as added and not selectable. */
  existing: Set<string>;
  onAdd:    (items: Array<{ assetId: string; projectId: string }>) => Promise<void>;
  onClose:  () => void;
}

export function AddVideosPicker({ existing, onAdd, onClose }: Readonly<Props>) {
  const [q, setQ] = useState('');
  const [assets, setAssets] = useState<ShareAssetOption[] | null>(null);
  const [picked, setPicked] = useState<Map<string, ShareAssetOption>>(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch(`/api/share-links/assets?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d: { assets?: ShareAssetOption[] }) => setAssets(d.assets ?? []))
        .catch(() => setAssets([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  // Group consecutive results by "Client · Project" (the API returns them sorted that way).
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: ShareAssetOption[] }> = [];
    for (const a of assets ?? []) {
      const label = [a.clientName, a.projectName].filter(Boolean).join(' · ');
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(a); else out.push({ label, items: [a] });
    }
    return out;
  }, [assets]);

  function toggle(a: ShareAssetOption) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(a.assetId)) next.delete(a.assetId); else next.set(a.assetId, a);
      return next;
    });
  }

  async function add() {
    setBusy(true);
    await onAdd([...picked.values()].map((a) => ({ assetId: a.assetId, projectId: a.projectId })));
    setBusy(false);
  }

  return (
    <div className="shm-picker">
      <input className="modal-input" autoFocus placeholder="Search videos, projects or clients" value={q}
        onChange={(e) => setQ(e.target.value)} aria-label="Search videos"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
      <div className="shm-picker-list">
        {assets === null ? <p className="modal-body-text">Loading…</p>
          : groups.length === 0 ? <p className="modal-body-text">No videos match.</p>
          : groups.map((g) => (
            <div key={g.label}>
              <div className="shm-label">{g.label}</div>
              {g.items.map((a) => {
                const already = existing.has(a.assetId);
                const on = picked.has(a.assetId);
                return (
                  <button key={a.assetId} type="button" disabled={already} aria-pressed={on}
                    className={`shm-pick${on ? ' is-on' : ''}`} onClick={() => toggle(a)}>
                    <span className="shm-check" aria-hidden="true">{already || on ? '✓' : ''}</span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.thumbnailUrl} alt="" className="shm-thumb" loading="lazy" />
                    <span className="shm-item-text">
                      <span>{a.platformTitle ?? a.name}</span>
                      {a.platformTitle && <span className="shm-item-sub">{a.name}</span>}
                    </span>
                    {already && <span className="shm-item-sub">In share</span>}
                  </button>
                );
              })}
            </div>
          ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="modal-btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="modal-btn-primary" disabled={!picked.size || busy} onClick={() => void add()}>
          {picked.size ? `Add ${picked.size} video${picked.size === 1 ? '' : 's'}` : 'Add videos'}
        </button>
      </div>
    </div>
  );
}
