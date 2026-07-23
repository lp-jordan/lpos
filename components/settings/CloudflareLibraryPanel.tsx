'use client';

import { useEffect, useMemo, useState } from 'react';

interface Video {
  uid: string;
  status: string;
  created: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  thumbnail: string | null;
  isLive: boolean;
  isTracked: boolean;
  assetId: string | null;
  projectId: string | null;
  assetName: string | null;
  projectName: string | null;
  clientName: string | null;
}

interface Totals {
  count: number;
  totalDurationSeconds: number;
  totalSizeBytes: number;
  liveCount: number;
  untrackedCount: number;
}

type SortKey = 'length' | 'size' | 'created' | 'name' | 'status';
type FilterKey = 'all' | 'tracked' | 'untracked';

// Cloudflare Stream storage is billed per minute of video stored.
const BUDGET_MINUTES = 4000;

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

export function CloudflareLibraryPanel() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>('length');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState<FilterKey>('all');

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/cloudflare-videos');
      const data = await res.json() as { configured?: boolean; videos?: Video[]; totals?: Totals | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to load Cloudflare library.');
      setConfigured(data.configured ?? true);
      setVideos(data.videos ?? []);
      setTotals(data.totals ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Sensible default direction per column: biggest/newest first, names A→Z.
      setSortDir(key === 'name' || key === 'status' ? 'asc' : 'desc');
    }
  }

  const visible = useMemo(() => {
    const filtered = videos.filter((v) => {
      if (filter === 'tracked') return v.isTracked;
      if (filter === 'untracked') return !v.isTracked;
      return true;
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'length': cmp = (a.durationSeconds ?? -1) - (b.durationSeconds ?? -1); break;
        case 'size': cmp = (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1); break;
        case 'created': cmp = (a.created ?? '').localeCompare(b.created ?? ''); break;
        case 'name': cmp = (a.assetName ?? '~').localeCompare(b.assetName ?? '~'); break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
      }
      return cmp * dir;
    });
  }, [videos, filter, sortKey, sortDir]);

  async function handleDelete(v: Video) {
    const label = v.assetName ?? v.uid;
    const base = `Permanently delete "${label}" from Cloudflare?\n\nThis frees ${formatDuration(v.durationSeconds)} of your ${BUDGET_MINUTES}-minute budget but cannot be undone.`;
    const first = v.isLive
      ? `${base}\n\n⚠️ This is a LIVE asset — deleting it will break the embed wherever it is served in LPOS or on delivery pages.`
      : base;
    if (!window.confirm(first)) return;
    if (v.isLive && !window.confirm(`Really delete the LIVE video for "${label}"? Type-confirm by pressing OK again.`)) return;

    setDeleting(v.uid);
    setActionError(null);
    try {
      const qs = v.isLive ? '?allowLive=1' : '';
      const res = await fetch(`/api/admin/cloudflare-videos/${encodeURIComponent(v.uid)}${qs}`, { method: 'DELETE' });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Delete failed.');
      setVideos((prev) => prev.filter((x) => x.uid !== v.uid));
      setTotals((prev) => prev && ({
        ...prev,
        count: prev.count - 1,
        totalDurationSeconds: prev.totalDurationSeconds - (v.durationSeconds ?? 0),
        totalSizeBytes: prev.totalSizeBytes - (v.sizeBytes ?? 0),
        liveCount: prev.liveCount - (v.isLive ? 1 : 0),
        untrackedCount: prev.untrackedCount - (v.isTracked ? 0 : 1),
      }));
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  const usedMinutes = totals ? totals.totalDurationSeconds / 60 : 0;
  const pct = Math.min(100, (usedMinutes / BUDGET_MINUTES) * 100);
  const pctColor = pct >= 90 ? 'var(--color-error, #e55)' : pct >= 70 ? 'var(--color-warning, #e6a23c)' : 'var(--color-accent, #4a9eff)';

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const th: React.CSSProperties = { textAlign: 'left', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em', opacity: 0.6, padding: '0.4rem 0.6rem', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '0.5rem 0.6rem', fontSize: '0.85rem', borderBottom: '1px solid var(--color-border, #333)', verticalAlign: 'middle' };

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Cloudflare library</h2>
        <p className="storage-settings-muted">
          Every video in the Cloudflare Stream account. Sort by length to find what is eating your{' '}
          {BUDGET_MINUTES}-minute storage budget, then delete what you no longer need.
        </p>
      </div>

      {totals && configured && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 4 }}>
            <span>
              <strong>{usedMinutes.toFixed(0)}</strong> / {BUDGET_MINUTES} min used
              <span style={{ opacity: 0.6 }}> · {totals.count} videos · {formatBytes(totals.totalSizeBytes)}</span>
            </span>
            <span style={{ opacity: 0.6 }}>{pct.toFixed(0)}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--color-border, #333)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: pctColor, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 6 }}>
            {totals.liveCount} live · {totals.untrackedCount} untracked / orphaned
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="storage-settings-primary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {(['all', 'tracked', 'untracked'] as FilterKey[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? 'var(--color-accent, #4a9eff)' : 'none',
              color: filter === f ? '#fff' : 'inherit',
              border: '1px solid var(--color-border, #333)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: '0.8rem',
              padding: '0.3rem 0.7rem',
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {!configured && !loading && (
        <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>
          Cloudflare Stream is not configured on this host. Set the Cloudflare credentials in Doppler to enable this panel.
        </p>
      )}
      {error && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}
      {actionError && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{actionError}</p>}

      {!loading && configured && visible.length === 0 && !error && (
        <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>No videos match this filter.</p>
      )}

      {!loading && configured && visible.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={th} onClick={() => toggleSort('name')}>Video{sortArrow('name')}</th>
                <th style={th} onClick={() => toggleSort('length')}>Length{sortArrow('length')}</th>
                <th style={th} onClick={() => toggleSort('size')}>Size{sortArrow('size')}</th>
                <th style={th} onClick={() => toggleSort('status')}>Status{sortArrow('status')}</th>
                <th style={th} onClick={() => toggleSort('created')}>Uploaded{sortArrow('created')}</th>
                <th style={{ ...th, cursor: 'default', textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => (
                <tr key={v.uid}>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', minWidth: 0 }}>
                      {v.thumbnail
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={v.thumbnail} alt="" width={64} height={36} style={{ borderRadius: 3, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
                        : <div style={{ width: 64, height: 36, borderRadius: 3, background: 'var(--color-border, #333)', flexShrink: 0 }} />}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                          {v.assetName ?? <span style={{ fontStyle: 'italic', opacity: 0.6 }}>Untitled</span>}
                          {v.isLive
                            ? <span style={{ marginLeft: 6, fontSize: '0.65rem', padding: '1px 5px', borderRadius: 3, background: 'var(--color-accent, #4a9eff)', color: '#fff', verticalAlign: 'middle' }}>LIVE</span>
                            : !v.isTracked && <span style={{ marginLeft: 6, fontSize: '0.65rem', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--color-warning, #e6a23c)', color: 'var(--color-warning, #e6a23c)', verticalAlign: 'middle' }}>ORPHAN</span>}
                        </div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                          {v.projectName
                            ? <>{v.projectName}{v.clientName && <span style={{ opacity: 0.7 }}> · {v.clientName}</span>}</>
                            : <span style={{ fontStyle: 'italic', opacity: 0.5 }}>Not linked to a project</span>}
                        </div>
                        <div style={{ fontSize: '0.68rem', opacity: 0.45, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{v.uid}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatDuration(v.durationSeconds)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(v.sizeBytes)}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', opacity: v.status === 'ready' ? 1 : 0.7 }}>{v.status}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap', opacity: 0.8 }}>{formatDate(v.created)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button
                      type="button"
                      onClick={() => void handleDelete(v)}
                      disabled={deleting === v.uid}
                      style={{
                        background: 'none',
                        border: '1px solid var(--color-error, #e55)',
                        borderRadius: 4,
                        cursor: deleting === v.uid ? 'default' : 'pointer',
                        color: 'var(--color-error, #e55)',
                        fontSize: '0.78rem',
                        opacity: deleting === v.uid ? 0.4 : 1,
                        padding: '0.25rem 0.6rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {deleting === v.uid ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
