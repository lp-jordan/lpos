'use client';

import { useEffect, useState } from 'react';

interface Orphan {
  uid: string;
  assetIdWhenOrphaned: string | null;
  projectIdWhenOrphaned: string | null;
  nameWhenOrphaned: string | null;
  projectName: string | null;
  clientName: string | null;
  reason: 'delete_failed' | 'reconciler';
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  lastError: string | null;
}

interface ReconcileSummary {
  ok: boolean;
  reason?: string;
  cloudflareCount: number;
  liveCount: number;
  candidateOrphans: number;
  newlyRecorded: number;
  refreshedExisting: number;
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

function reasonLabel(reason: Orphan['reason']): string {
  return reason === 'delete_failed' ? 'Delete failed during re-push' : 'Found by reconciler';
}

export function CloudflareOrphansPanel() {
  const [orphans, setOrphans]   = useState<Orphan[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [purging, setPurging]   = useState<string | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<ReconcileSummary | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/cloudflare-orphans');
      if (!res.ok) throw new Error('Failed to load orphan list.');
      const data = await res.json() as { orphans: Orphan[] };
      setOrphans(data.orphans);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function runScanNow() {
    setScanning(true);
    setPurgeError(null);
    try {
      const res = await fetch('/api/admin/cloudflare-orphans', { method: 'POST' });
      const data = await res.json() as { summary?: ReconcileSummary; orphans?: Orphan[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Reconcile failed.');
      setScanSummary(data.summary ?? null);
      if (data.orphans) setOrphans(data.orphans);
    } catch (err) {
      setPurgeError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function handlePurge(uid: string) {
    const confirmed = window.confirm(
      `Permanently delete Cloudflare video ${uid}?\n\nThis cannot be undone. Make sure this video isn't live anywhere — once it's gone, any embed pointing at it will break.`,
    );
    if (!confirmed) return;
    setPurging(uid);
    setPurgeError(null);
    try {
      const res = await fetch(`/api/admin/cloudflare-orphans/${encodeURIComponent(uid)}`, { method: 'DELETE' });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Purge failed.');
      setOrphans((prev) => prev.filter((o) => o.uid !== uid));
    } catch (err) {
      setPurgeError((err as Error).message);
    } finally {
      setPurging(null);
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Cloudflare orphans</h2>
        <p className="storage-settings-muted">
          Videos that exist at Cloudflare but are not tracked as live by LPOS. Detection is automatic
          (daily sweep); deletion is manual — review each entry before purging.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="storage-settings-primary"
          onClick={() => void runScanNow()}
          disabled={scanning}
        >
          {scanning ? 'Scanning…' : 'Run scan now'}
        </button>
        {scanSummary && (
          <span className="storage-settings-muted" style={{ fontSize: '0.85rem' }}>
            {scanSummary.ok
              ? `Last scan — Cloudflare: ${scanSummary.cloudflareCount}, live: ${scanSummary.liveCount}, candidates: ${scanSummary.candidateOrphans} (${scanSummary.newlyRecorded} new)`
              : `Scan skipped: ${scanSummary.reason}`}
          </span>
        )}
      </div>

      {loading && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}
      {purgeError && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{purgeError}</p>}

      {!loading && orphans.length === 0 && !error && (
        <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>
          No orphans detected. Cloudflare is in sync with LPOS.
        </p>
      )}

      {!loading && orphans.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
          {orphans.map((o) => (
            <li
              key={o.uid}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                padding: '0.6rem 0',
                borderBottom: '1px solid var(--color-border, #333)',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.nameWhenOrphaned ?? <span style={{ fontStyle: 'italic', opacity: 0.6 }}>Unknown asset</span>}
                </div>
                <div style={{ fontSize: '0.8rem', opacity: 0.85, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.projectName
                    ? <>{o.projectName}{o.clientName && <span style={{ opacity: 0.7 }}> · {o.clientName}</span>}</>
                    : o.projectIdWhenOrphaned
                      ? <span style={{ fontFamily: 'monospace', opacity: 0.7 }}>project {o.projectIdWhenOrphaned}</span>
                      : <span style={{ fontStyle: 'italic', opacity: 0.55 }}>Project unknown</span>}
                </div>
                <div style={{ fontSize: '0.72rem', opacity: 0.55, marginTop: 4, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  CF {o.uid}
                  {o.assetIdWhenOrphaned && <> · asset {o.assetIdWhenOrphaned}</>}
                </div>
                <div style={{ fontSize: '0.72rem', opacity: 0.55, marginTop: 2 }}>
                  {reasonLabel(o.reason)}
                  {' · '}First seen {formatDate(o.firstSeenAt)}
                  {o.attempts > 0 && ` · ${o.attempts} purge attempt${o.attempts === 1 ? '' : 's'}`}
                </div>
                {o.lastError && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--color-error, #e55)', marginTop: 2 }}>
                    Last error: {o.lastError}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handlePurge(o.uid)}
                disabled={purging === o.uid}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-error, #e55)',
                  borderRadius: 4,
                  cursor: purging === o.uid ? 'default' : 'pointer',
                  color: 'var(--color-error, #e55)',
                  fontSize: '0.8rem',
                  opacity: purging === o.uid ? 0.4 : 1,
                  padding: '0.3rem 0.7rem',
                  whiteSpace: 'nowrap',
                }}
              >
                {purging === o.uid ? 'Purging…' : 'Purge from Cloudflare'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
