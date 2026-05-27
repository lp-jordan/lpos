'use client';

import { useCallback, useEffect, useState } from 'react';
import { ColdStorageBrowser } from './ColdStorageBrowser';

interface ColdStorageObject {
  key:           string;
  size:          number;
  uploadedAt:    string;
  lastSeenAt:    string;
  missingSince:  string | null;
  deletedAt:     string | null;
}

interface ColdStorageStats {
  activeObjects:    number;
  activeBytes:      number;
  missingObjects:   number;
  queuedForDelete:  number;
  deletedHistory:   number;
}

interface SyncRunResult {
  timestamp:    string;
  dirs:         string[];
  uploaded:     number;
  skipped:      number;
  failed:       number;
  newlyMissing: number;
  deleted:      number;
  errors:       Array<{ key: string; error: string }>;
  stats:        ColdStorageStats;
}

interface SyncStatus {
  configured:  boolean;
  running:     boolean;
  nextRunHour: number;
  syncDirs:    string[];
  retainDays:  number;
  lastRun:     SyncRunResult | null;
}

interface Config {
  syncDirs:   string[];
  retainDays: number;
  syncHour:   number;
  updatedAt:  string;
}

interface OverviewResponse {
  status:                 SyncStatus;
  config:                 Config;
  stats:                  ColdStorageStats;
  queuedForDeletion:      ColdStorageObject[];
  missingWithinRetention: ColdStorageObject[];
}

function bytesToHuman(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatHour(h: number): string {
  const period  = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

function daysUntilDeletion(missingSince: string, retainDays: number): number {
  const since   = new Date(missingSince).getTime();
  const deadline = since + retainDays * 24 * 60 * 60 * 1000;
  const ms      = deadline - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function relativeTime(iso: string): string {
  const now  = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  if (diff < 0) return iso;
  const mins = Math.round(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function ColdStorageSection() {
  const [data, setData]         = useState<OverviewResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const [dirsText, setDirsText]     = useState('');
  const [retainDays, setRetainDays] = useState(30);
  const [syncHour, setSyncHour]     = useState(2);
  const [saving, setSaving]         = useState(false);
  const [savedAt, setSavedAt]       = useState<string | null>(null);

  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/admin/cold-storage', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load cold storage status.');
      const json = await res.json() as OverviewResponse;
      setData(json);
      setDirsText(json.config.syncDirs.join('\n'));
      setRetainDays(json.config.retainDays);
      setSyncHour(json.config.syncHour);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Auto-refresh once a minute so a running sync surfaces as it completes
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function saveConfig() {
    setSaving(true);
    setSavedAt(null);
    setError(null);
    try {
      const syncDirs = dirsText.split('\n').map((d) => d.trim()).filter(Boolean);
      const res = await fetch('/api/admin/b2-sync-config', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ syncDirs, retainDays, syncHour }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Save failed');
      }
      await load();
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function triggerNow() {
    setTriggering(true);
    setTriggerMsg(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/cold-storage/trigger', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Trigger failed');
      }
      setTriggerMsg('Sync started — refresh in a few minutes to see results.');
      // Optimistic: mark running
      setData((prev) => prev ? { ...prev, status: { ...prev.status, running: true } } : prev);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTriggering(false);
    }
  }

  if (loading) {
    return (
      <div className="storage-settings-card">
        <h2 className="storage-settings-section-title">Raw Footage Cold Storage</h2>
        <p className="storage-settings-muted">Loading…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="storage-settings-card">
        <h2 className="storage-settings-section-title">Raw Footage Cold Storage</h2>
        <p className="storage-settings-muted" style={{ color: '#ffb4ab' }}>
          {error ?? 'Status unavailable.'}
        </p>
      </div>
    );
  }

  const { status, stats, queuedForDeletion, missingWithinRetention } = data;
  const credsOk = status.configured;

  // Status dot — idle | running | recent-ok | recent-error
  let dotClass = 'cold-storage-dot--idle';
  let dotLabel = 'Idle';
  if (status.running) {
    dotClass = 'cold-storage-dot--running';
    dotLabel = 'Running…';
  } else if (status.lastRun) {
    if (status.lastRun.failed > 0 || status.lastRun.errors.length > 0) {
      dotClass = 'cold-storage-dot--error';
      dotLabel = 'Last run had errors';
    } else {
      dotClass = 'cold-storage-dot--ok';
      dotLabel = `Last run ${relativeTime(status.lastRun.timestamp)}`;
    }
  }

  return (
    <div className="storage-settings-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 className="storage-settings-section-title">Raw Footage Cold Storage</h2>
          <p className="storage-settings-muted">
            Peace-of-mind cold storage in Backblaze B2 for raw footage on active projects.
            Disappearance-tracked retention — a file is only purged from B2 after it has been
            missing from every source folder for <strong>{status.retainDays} consecutive nights</strong>.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`cold-storage-dot ${dotClass}`} aria-hidden />
          <span className="storage-settings-muted" style={{ fontSize: '0.9em' }}>{dotLabel}</span>
        </div>
      </div>

      {!credsOk && (
        <p className="storage-settings-muted" style={{ color: '#ffb4ab', marginTop: 12 }}>
          B2 credentials (B2_MEDIA_ENDPOINT / KEY_ID / APPLICATION_KEY / BUCKET) are not set in
          Doppler — sync stays idle until they are.
        </p>
      )}
      {error && (
        <p className="storage-settings-muted" style={{ color: '#ffb4ab', marginTop: 12 }}>{error}</p>
      )}

      {/* Stats strip */}
      <div className="cold-storage-stats">
        <div>
          <span className="cold-storage-stat-label">In cold storage</span>
          <strong>{stats.activeObjects.toLocaleString()} files</strong>
          <span className="storage-settings-muted">{bytesToHuman(stats.activeBytes)}</span>
        </div>
        <div>
          <span className="cold-storage-stat-label">Missing (within retention)</span>
          <strong>{stats.missingObjects.toLocaleString()}</strong>
          <span className="storage-settings-muted">file{stats.missingObjects === 1 ? '' : 's'}</span>
        </div>
        <div>
          <span className="cold-storage-stat-label">Queued for deletion</span>
          <strong style={{ color: stats.queuedForDelete > 0 ? '#ffb4ab' : undefined }}>
            {stats.queuedForDelete.toLocaleString()}
          </strong>
          <span className="storage-settings-muted">retention elapsed</span>
        </div>
        <div>
          <span className="cold-storage-stat-label">Deleted (90-day history)</span>
          <strong>{stats.deletedHistory.toLocaleString()}</strong>
          <span className="storage-settings-muted">recent</span>
        </div>
      </div>

      {/* Source dirs */}
      <div style={{ marginTop: 20 }}>
        <label htmlFor="cs-sync-dirs" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          Source directories
        </label>
        <textarea
          id="cs-sync-dirs"
          value={dirsText}
          onChange={(e) => setDirsText(e.target.value)}
          rows={Math.max(3, dirsText.split('\n').length)}
          placeholder={`/Volumes/NAS/Projects\n/Volumes/NAS/Audio`}
          style={{
            width: '100%',
            fontFamily: 'monospace',
            fontSize: '0.9em',
            padding: 8,
            borderRadius: 8,
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'inherit',
          }}
        />
        <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 4 }}>
          One absolute path per line, on the LPOS server. Easier to set these via the LPOS Server
          tray app&apos;s native folder picker — values you set there land here automatically.
        </p>
      </div>

      {/* Knobs */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 16 }}>
        <div>
          <label htmlFor="cs-retain-days" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            Retention (days)
          </label>
          <input
            id="cs-retain-days"
            type="number"
            min={1}
            max={3650}
            value={retainDays}
            onChange={(e) => setRetainDays(Number(e.target.value))}
            style={{
              width: 100, padding: 6, borderRadius: 6,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'inherit',
            }}
          />
          <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 4 }}>
            Nights missing from source before deletion.
          </p>
        </div>
        <div>
          <label htmlFor="cs-sync-hour" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            Sync hour
          </label>
          <select
            id="cs-sync-hour"
            value={syncHour}
            onChange={(e) => setSyncHour(Number(e.target.value))}
            style={{
              padding: 6, borderRadius: 6,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'inherit',
            }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{formatHour(h)}</option>
            ))}
          </select>
          <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 4 }}>
            Server local time, once per day.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="storage-settings-primary"
          onClick={saveConfig}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save config'}
        </button>
        <button
          type="button"
          className="storage-settings-secondary"
          onClick={triggerNow}
          disabled={triggering || status.running || !credsOk || status.syncDirs.length === 0}
        >
          {status.running ? 'Running…' : triggering ? 'Triggering…' : 'Sync Now'}
        </button>
        {savedAt && (
          <span className="storage-settings-muted" style={{ fontSize: '0.85em' }}>
            Saved at {savedAt}
          </span>
        )}
        {triggerMsg && (
          <span className="storage-settings-muted" style={{ fontSize: '0.85em' }}>{triggerMsg}</span>
        )}
      </div>

      {/* Last run summary */}
      {status.lastRun && (
        <div className="cold-storage-lastrun">
          <h3 className="storage-settings-section-title" style={{ fontSize: '1em', marginBottom: 6 }}>
            Last run
          </h3>
          <p className="storage-settings-muted" style={{ fontSize: '0.9em' }}>
            {new Date(status.lastRun.timestamp).toLocaleString()} —
            {' '}{status.lastRun.uploaded} uploaded,
            {' '}{status.lastRun.skipped} unchanged,
            {' '}{status.lastRun.newlyMissing} newly missing,
            {' '}{status.lastRun.deleted} retired,
            {' '}{status.lastRun.failed} failed
          </p>
          {status.lastRun.errors.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary className="storage-settings-muted" style={{ cursor: 'pointer', fontSize: '0.85em' }}>
                {status.lastRun.errors.length} error{status.lastRun.errors.length === 1 ? '' : 's'}
              </summary>
              <ul style={{ marginTop: 6, fontSize: '0.8em', fontFamily: 'monospace', maxHeight: 160, overflow: 'auto' }}>
                {status.lastRun.errors.slice(0, 50).map((e, i) => (
                  <li key={i} style={{ color: '#ffb4ab' }}>
                    <code>{e.key}</code> — {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Queued + missing tables */}
      {queuedForDeletion.length > 0 && (
        <div className="cold-storage-table-wrap">
          <h3 className="storage-settings-section-title" style={{ fontSize: '1em' }}>
            Queued for deletion ({queuedForDeletion.length})
          </h3>
          <p className="storage-settings-muted" style={{ fontSize: '0.85em' }}>
            Retention has elapsed — next sync will delete these from B2. Restore the source file
            before the next run to cancel.
          </p>
          <div className="cold-storage-table">
            {queuedForDeletion.slice(0, 50).map((obj) => (
              <div key={obj.key} className="cold-storage-row">
                <code className="cold-storage-key">{obj.key}</code>
                <span className="cold-storage-meta">{bytesToHuman(obj.size)}</span>
                <span className="cold-storage-meta cold-storage-meta--warn">
                  missing since {obj.missingSince ? new Date(obj.missingSince).toLocaleDateString() : '—'}
                </span>
              </div>
            ))}
            {queuedForDeletion.length > 50 && (
              <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 6 }}>
                +{queuedForDeletion.length - 50} more…
              </p>
            )}
          </div>
        </div>
      )}

      {missingWithinRetention.length > 0 && (
        <div className="cold-storage-table-wrap">
          <h3 className="storage-settings-section-title" style={{ fontSize: '1em' }}>
            Missing — within retention window ({missingWithinRetention.length})
          </h3>
          <p className="storage-settings-muted" style={{ fontSize: '0.85em' }}>
            Source file disappeared but retention hasn&apos;t elapsed yet. Restore to cancel deletion.
          </p>
          <div className="cold-storage-table">
            {missingWithinRetention.slice(0, 50).map((obj) => (
              <div key={obj.key} className="cold-storage-row">
                <code className="cold-storage-key">{obj.key}</code>
                <span className="cold-storage-meta">{bytesToHuman(obj.size)}</span>
                <span className="cold-storage-meta">
                  {obj.missingSince
                    ? `deletes in ${daysUntilDeletion(obj.missingSince, status.retainDays)}d`
                    : '—'}
                </span>
              </div>
            ))}
            {missingWithinRetention.length > 50 && (
              <p className="storage-settings-muted" style={{ fontSize: '0.8em', marginTop: 6 }}>
                +{missingWithinRetention.length - 50} more…
              </p>
            )}
          </div>
        </div>
      )}

      {/* Bucket browser */}
      <ColdStorageBrowser credsOk={credsOk} />
    </div>
  );
}
