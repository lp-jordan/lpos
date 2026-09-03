'use client';
import { useEffect, useMemo, useState } from 'react';
import type { AssetOption, HubDetail, OwnerType } from './types';
import { fmtDuration } from './types';

interface Props {
  hubId: string;
  onClose: () => void;
  onSaved: () => void;
}

interface Selected {
  project_id: string;
  client_title: string;
}

export function ManageHubModal({ hubId, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'videos' | 'access'>('videos');

  const [name, setName] = useState('');
  const [ownerLabel, setOwnerLabel] = useState('');
  const [ownerType, setOwnerType] = useState<OwnerType>('client');

  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [selected, setSelected] = useState<Record<string, Selected>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [access, setAccess] = useState<string[]>([]);

  const [search, setSearch] = useState('');
  const [videoView, setVideoView] = useState<'inhub' | 'all'>('inhub');
  const [projectFilter, setProjectFilter] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [dRes, aRes] = await Promise.all([fetch(`/api/link-hubs/${hubId}`), fetch('/api/link-hubs/assets')]);
        if (!dRes.ok) throw new Error('Failed to load hub');
        const detail = (await dRes.json()) as HubDetail;
        const assetData = (await aRes.json().catch(() => ({ assets: [] }))) as { assets?: AssetOption[] };
        if (cancelled) return;

        setName(detail.hub.name);
        setOwnerLabel(detail.hub.owner_label);
        setOwnerType(detail.hub.owner_type);
        setAccess(detail.access);
        const sel: Record<string, Selected> = {};
        const ord: string[] = [];
        for (const it of detail.items) {
          sel[it.asset_id] = { project_id: it.project_id, client_title: it.client_title };
          ord.push(it.asset_id);
        }
        setSelected(sel);
        setOrder(ord);
        setAssets(assetData.assets ?? []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hubId]);

  const assetById = useMemo(() => {
    const m: Record<string, AssetOption> = {};
    for (const a of assets) m[a.assetId] = a;
    return m;
  }, [assets]);

  // Projects present in the asset list, for the filter dropdown.
  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of assets) if (!map.has(a.projectId)) map.set(a.projectId, `${a.clientName} · ${a.projectName}`);
    return [...map.entries()].map(([id, label]) => ({ id, label })).sort((x, y) => x.label.localeCompare(y.label));
  }, [assets]);

  // The list to show, grouped by project. "In hub" reads from `order` (source of
  // truth) so it shows the hub's contents even if a project is archived.
  const displayGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base: AssetOption[] =
      videoView === 'inhub'
        ? order.map(
            (id) =>
              assetById[id] ?? {
                assetId: id,
                projectId: selected[id]?.project_id ?? '',
                projectName: 'Project unavailable',
                clientName: '—',
                name: selected[id]?.client_title ?? id,
                durationS: 0,
                thumbnailUrl: null,
                cfStatus: null,
              },
          )
        : assets;

    const list = base.filter((a) => {
      if (projectFilter && a.projectId !== projectFilter) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.clientName.toLowerCase().includes(q) ||
        a.projectName.toLowerCase().includes(q) ||
        (selected[a.assetId]?.client_title ?? '').toLowerCase().includes(q)
      );
    });

    const groups = new Map<string, { label: string; items: AssetOption[] }>();
    for (const a of list) {
      const key = a.projectId || a.projectName;
      if (!groups.has(key)) groups.set(key, { label: `${a.clientName} · ${a.projectName}`, items: [] });
      groups.get(key)!.items.push(a);
    }
    const arr = [...groups.values()].sort((x, y) => x.label.localeCompare(y.label));
    for (const g of arr) g.items.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [assets, assetById, order, selected, search, videoView, projectFilter]);

  function toggle(a: AssetOption) {
    if (selected[a.assetId]) {
      setSelected((s) => {
        const next = { ...s };
        delete next[a.assetId];
        return next;
      });
      setOrder((o) => o.filter((id) => id !== a.assetId));
    } else {
      setSelected((s) => ({ ...s, [a.assetId]: { project_id: a.projectId, client_title: a.name } }));
      setOrder((o) => [...o, a.assetId]);
    }
  }

  function setTitle(assetId: string, title: string) {
    setSelected((s) => ({ ...s, [assetId]: { ...s[assetId], client_title: title } }));
  }

  function addEmail() {
    const e = newEmail.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    if (!access.includes(e)) setAccess((a) => [...a, e]);
    setNewEmail('');
  }

  async function save() {
    if (!name.trim()) {
      setError('Hub name is required.');
      setTab('videos');
      return;
    }
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const items = order.map((id) => ({
        asset_id: id,
        project_id: selected[id].project_id,
        client_title: selected[id].client_title,
      }));
      const res = await fetch(`/api/link-hubs/${hubId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), owner_label: (ownerLabel || name).trim(), owner_type: ownerType, items, access }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to save');
      }
      const data = (await res.json()) as { push?: { pushed: boolean; reason?: string; videos?: number; skipped?: string[] } };
      onSaved();
      const p = data.push;
      if (p?.pushed) {
        let msg = `Saved · pushed ${p.videos ?? 0} video${p.videos === 1 ? '' : 's'} to the delivery app.`;
        if (p.skipped?.length) msg += ` (${p.skipped.length} skipped — no Cloudflare video yet.)`;
        setStatus(msg);
      } else {
        setStatus(`Saved in LPOS · not pushed: ${p?.reason ?? 'delivery app unavailable'}.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectedCount = order.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 640, width: '100%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Manage link hub</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading ? (
          <p className="modal-body-text">Loading…</p>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '0 0 4px' }}>
              <div className="modal-field">
                <label className="modal-label">Hub name</label>
                <input className="modal-input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="modal-field">
                <label className="modal-label">Owner label</label>
                <input className="modal-input" value={ownerLabel} onChange={(e) => setOwnerLabel(e.target.value)} />
              </div>
            </div>

            <div className="modal-mode-toggle" style={{ marginBottom: 4 }}>
              <button type="button" className={`modal-mode-btn${tab === 'videos' ? ' active' : ''}`} onClick={() => setTab('videos')}>
                Videos · {selectedCount}
              </button>
              <button type="button" className={`modal-mode-btn${tab === 'access' ? ' active' : ''}`} onClick={() => setTab('access')}>
                Access · {access.length}
              </button>
            </div>

            {tab === 'videos' && (
              <div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div className="modal-mode-toggle" style={{ flex: '0 0 auto' }}>
                    <button type="button" className={`modal-mode-btn${videoView === 'inhub' ? ' active' : ''}`} onClick={() => setVideoView('inhub')}>
                      In hub · {selectedCount}
                    </button>
                    <button type="button" className={`modal-mode-btn${videoView === 'all' ? ' active' : ''}`} onClick={() => setVideoView('all')}>
                      All videos
                    </button>
                  </div>
                  <select
                    className="modal-input"
                    style={{ flex: '1 1 150px', maxWidth: 240 }}
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    aria-label="Filter by project"
                  >
                    <option value="">All projects</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <input
                  className="modal-input"
                  style={{ marginBottom: 10 }}
                  placeholder="Search by title, client, or project…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div style={{ maxHeight: '40vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {displayGroups.length === 0 && (
                    <p className="modal-body-text" style={{ padding: '8px 2px' }}>
                      {videoView === 'inhub' ? 'No videos in this hub yet — switch to “All videos” to add some.' : 'No playable videos found.'}
                    </p>
                  )}
                  {displayGroups.map((g) => (
                    <div key={g.label}>
                      <div
                        style={{
                          position: 'sticky',
                          top: 0,
                          zIndex: 1,
                          background: 'var(--surface-2, #182430)',
                          padding: '7px 4px 6px',
                          fontSize: 11,
                          letterSpacing: '0.05em',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                          color: 'var(--muted-soft, #9d9287)',
                          borderBottom: '1px solid var(--line, rgba(113,131,150,0.2))',
                          marginBottom: 4,
                        }}
                      >
                        {g.label} <span style={{ opacity: 0.7 }}>({g.items.length})</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {g.items.map((a) => {
                          const on = !!selected[a.assetId];
                          return (
                            <div
                              key={a.assetId}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 11,
                                padding: '9px 11px',
                                border: '1px solid var(--line)',
                                borderRadius: 10,
                                background: on ? 'var(--accent-soft, rgba(219,175,95,0.12))' : 'var(--surface-inset, rgba(11,16,22,0.5))',
                              }}
                            >
                              <input type="checkbox" checked={on} onChange={() => toggle(a)} aria-label={`Include ${a.name}`} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                {on ? (
                                  <input
                                    className="modal-input"
                                    style={{ fontSize: '0.82rem', padding: '6px 9px' }}
                                    value={selected[a.assetId].client_title}
                                    onChange={(e) => setTitle(a.assetId, e.target.value)}
                                    placeholder="Client-facing title"
                                  />
                                ) : (
                                  <div style={{ fontSize: 13, color: 'var(--text, #f4eee2)' }}>{a.name}</div>
                                )}
                                <div style={{ fontSize: 11, color: 'var(--muted-soft, #9d9287)', marginTop: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {[on ? `LPOS: ${a.name}` : null, a.durationS ? fmtDuration(a.durationS) : null, a.cfStatus && a.cfStatus !== 'ready' ? `CF: ${a.cfStatus}` : null].filter(Boolean).join(' · ')}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'access' && (
              <div>
                <label className="modal-label">Login emails</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0 12px' }}>
                  {access.length === 0 && <span className="modal-body-text" style={{ padding: 0 }}>No login emails yet — add one below.</span>}
                  {access.map((em) => (
                    <span
                      key={em}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12.5,
                        padding: '6px 10px',
                        border: '1px solid var(--line-strong, rgba(146,166,185,0.34))',
                        borderRadius: 8,
                        fontFamily: 'monospace',
                      }}
                    >
                      {em}
                      <button
                        type="button"
                        onClick={() => setAccess((a) => a.filter((x) => x !== em))}
                        aria-label={`Remove ${em}`}
                        style={{ border: 'none', background: 'none', color: 'var(--muted-soft, #9d9287)', cursor: 'pointer', fontSize: 14 }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="modal-input"
                    type="email"
                    placeholder="orlando@company.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEmail();
                      }
                    }}
                  />
                  <button type="button" className="modal-btn-primary" onClick={addEmail}>Add</button>
                </div>
                <p className="modal-body-text" style={{ padding: 0, marginTop: 10, fontSize: '0.8rem' }}>
                  Anyone on this list gets a magic-link sign-in to this hub. One email can hold access to several hubs.
                </p>
              </div>
            )}

            {error && <p className="modal-error">{error}</p>}
            {status && (
              <p className="modal-body-text" style={{ padding: 0, color: 'var(--accent-strong, #f2cf91)' }}>{status}</p>
            )}
            <div className="modal-actions">
              <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={saving}>Close</button>
              <button type="button" className="modal-btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
