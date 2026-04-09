'use client';

import { useState, useEffect, useCallback } from 'react';

interface DriveStatus {
  configured:       boolean;
  driveId:          string | null;
  webhookUrl:       string | null;
  webhookTokenSet:  boolean;
  active:           boolean;
  channelExpiresAt: string | null;
  channel:          { channelId: string; expiresAt: string } | null;
}

interface BackfillResult {
  ok:           boolean;
  projectCount: number;
}

interface ScanResult {
  fileCount:       number;
  transcriptCount: number;
}

function hoursUntil(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60);
}

function channelHealthChip(status: DriveStatus): { label: string; cls: string } {
  if (!status.configured)      return { label: 'Not configured', cls: 'ma-badge ma-badge--error' };
  if (!status.active)          return { label: 'No channel',     cls: 'ma-badge ma-badge--error' };
  if (!status.channelExpiresAt) return { label: 'Unknown',       cls: 'ma-badge ma-badge--neutral' };
  const hours = hoursUntil(status.channelExpiresAt);
  if (hours < 0)   return { label: 'Expired',        cls: 'ma-badge ma-badge--error' };
  if (hours < 24)  return { label: 'Expiring soon',  cls: 'ma-badge ma-badge--pending' };
  return { label: 'Connected', cls: 'ma-badge ma-badge--success' };
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function redact(val: string | null): string {
  if (!val) return '—';
  if (val.length <= 8) return '••••••••';
  return val.slice(0, 6) + '••••' + val.slice(-4);
}

export function DriveSettingsClient() {
  const [status,        setStatus]        = useState<DriveStatus | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [setupRunning,  setSetupRunning]  = useState(false);
  const [setupMsg,      setSetupMsg]      = useState<string | null>(null);
  const [reregRunning,  setReregRunning]  = useState(false);
  const [reregMsg,      setReregMsg]      = useState<string | null>(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillResult,  setBackfillResult]  = useState<BackfillResult | null>(null);
  const [scanRunning,   setScanRunning]   = useState(false);
  const [scanResult,    setScanResult]    = useState<ScanResult | null>(null);
  const [error,         setError]         = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/admin/drive');
      const data = await res.json() as DriveStatus;
      setStatus(data);
    } catch {
      setError('Failed to load Drive status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  async function handleSetup() {
    setSetupRunning(true);
    setSetupMsg(null);
    setError(null);
    try {
      const res  = await fetch('/api/admin/drive', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data.error) throw new Error(data.error);
      setSetupMsg('Setup complete. Channel registered.');
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSetupRunning(false);
    }
  }

  async function handleRereg() {
    setReregRunning(true);
    setReregMsg(null);
    setError(null);
    try {
      const res  = await fetch('/api/admin/drive?force=true', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data.error) throw new Error(data.error);
      setReregMsg('Channel re-registered. Drive will send a sync handshake shortly.');
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReregRunning(false);
    }
  }

  async function handleBackfill() {
    setBackfillRunning(true);
    setBackfillResult(null);
    setError(null);
    try {
      const res  = await fetch('/api/admin/drive/backfill', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; projectCount?: number; error?: string };
      if (data.error) throw new Error(data.error);
      setBackfillResult({ ok: true, projectCount: data.projectCount ?? 0 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBackfillRunning(false);
    }
  }

  async function handleScan() {
    setScanRunning(true);
    setScanResult(null);
    setError(null);
    try {
      const res  = await fetch('/api/admin/drive/scan', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; fileCount?: number; transcriptCount?: number; error?: string };
      if (data.error) throw new Error(data.error);
      setScanResult({ fileCount: data.fileCount ?? 0, transcriptCount: data.transcriptCount ?? 0 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanRunning(false);
    }
  }

  const chip = status ? channelHealthChip(status) : null;

  return (
    <section className="storage-settings-page">
      <div className="storage-settings-hero">
        <div>
          <p className="storage-settings-kicker">Settings · Drive</p>
          <h1 className="storage-settings-title">Google Drive</h1>
          <p className="storage-settings-copy">
            Manage the Shared Team Drive integration — connection health, folder setup, and project backfill.
          </p>
        </div>
      </div>

      {error && (
        <div className="storage-settings-card" style={{ borderColor: 'rgba(216,100,100,0.4)' }}>
          <p style={{ color: '#d87070', margin: 0, fontSize: '0.9rem' }}>⚠ {error}</p>
        </div>
      )}

      {/* ── Connection status ── */}
      <div className="storage-settings-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <h2 className="storage-settings-section-title" style={{ margin: 0 }}>Connection</h2>
          {chip && <span className={chip.cls}>{chip.label}</span>}
        </div>

        {loading ? (
          <p className="storage-settings-muted">Loading…</p>
        ) : status ? (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            <div>
              <span className="storage-settings-label">Shared Drive ID</span>
              <strong style={{ fontSize: '0.88rem', fontFamily: 'monospace' }}>
                {status.driveId ?? <span style={{ color: 'var(--muted-soft)' }}>not set</span>}
              </strong>
            </div>
            <div>
              <span className="storage-settings-label">Webhook URL</span>
              <strong style={{ fontSize: '0.88rem', fontFamily: 'monospace' }}>
                {status.webhookUrl ?? <span style={{ color: 'var(--muted-soft)' }}>not set</span>}
              </strong>
            </div>
            {status.channelExpiresAt && (
              <div>
                <span className="storage-settings-label">Channel expires</span>
                <strong style={{ fontSize: '0.88rem' }}>{formatExpiry(status.channelExpiresAt)}</strong>
              </div>
            )}
          </div>
        ) : null}

        <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="storage-settings-primary"
            onClick={() => void handleSetup()}
            disabled={setupRunning}
          >
            {setupRunning ? 'Setting up…' : 'Setup / Refresh'}
          </button>
          <button
            className="storage-settings-secondary"
            onClick={() => void handleRereg()}
            disabled={reregRunning || !status?.configured}
            title="Force-replace the watch channel — use this if webhooks stopped working after a URL or Funnel change"
          >
            {reregRunning ? 'Re-registering…' : 'Re-register Channel'}
          </button>
          {setupMsg && <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>{setupMsg}</span>}
          {reregMsg && <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>{reregMsg}</span>}
        </div>
      </div>

      {/* ── Backfill ── */}
      <div className="storage-settings-card">
        <h2 className="storage-settings-section-title">Project Folders</h2>
        <p className="storage-settings-muted" style={{ marginBottom: '1rem' }}>
          Create Drive folder trees for all existing LPOS projects. Safe to re-run — folders are only
          created if they don&apos;t already exist.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            className="storage-settings-secondary"
            onClick={() => void handleBackfill()}
            disabled={backfillRunning || !status?.configured}
          >
            {backfillRunning ? 'Creating folders…' : 'Create All Project Folders'}
          </button>
          {backfillResult && (
            <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>
              ✓ {backfillResult.projectCount} project{backfillResult.projectCount !== 1 ? 's' : ''} confirmed
            </span>
          )}
          {!status?.configured && (
            <span style={{ fontSize: '0.82rem', color: 'var(--muted-soft)' }}>
              Configure env vars first
            </span>
          )}
        </div>
      </div>

      {/* ── Scan existing assets ── */}
      <div className="storage-settings-card">
        <h2 className="storage-settings-section-title">Asset Index</h2>
        <p className="storage-settings-muted" style={{ marginBottom: '1rem' }}>
          Scan all project Assets folders in Drive and index any files not yet visible in LPOS.
          Run this after first setup or if files are missing from the Assets tab.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            className="storage-settings-secondary"
            onClick={() => void handleScan()}
            disabled={scanRunning || !status?.configured}
          >
            {scanRunning ? 'Scanning…' : 'Scan Existing Assets'}
          </button>
          {scanResult && (
            <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>
              ✓ {scanResult.fileCount} asset{scanResult.fileCount !== 1 ? 's' : ''} indexed,{' '}
              {scanResult.transcriptCount} transcript{scanResult.transcriptCount !== 1 ? 's' : ''} pushed
            </span>
          )}
          {!status?.configured && (
            <span style={{ fontSize: '0.82rem', color: 'var(--muted-soft)' }}>
              Configure env vars first
            </span>
          )}
        </div>
      </div>

      {/* ── Config reference ── */}
      <div className="storage-settings-card">
        <h2 className="storage-settings-section-title">Environment Variables</h2>
        <p className="storage-settings-muted" style={{ marginBottom: '1rem' }}>
          These must be set in <code>.env.local</code> before starting the server.
        </p>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {([
            ['GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH', './data/drive-service-account.json'],
            ['GOOGLE_DRIVE_SHARED_DRIVE_ID',      status?.driveId ?? null],
            ['GOOGLE_DRIVE_WEBHOOK_URL',           status?.webhookUrl ?? null],
            ['GOOGLE_DRIVE_WEBHOOK_TOKEN',         status?.webhookTokenSet ? '••••••••' : null],
          ] as [string, string | null][]).map(([key, val]) => (
            <div key={key} style={{ display: 'flex', gap: '1rem', alignItems: 'baseline' }}>
              <code style={{
                fontSize: '0.78rem',
                color: 'var(--accent)',
                minWidth: 280,
                flexShrink: 0,
              }}>{key}</code>
              <span style={{ fontSize: '0.82rem', color: val ? 'var(--success)' : 'var(--muted-soft)' }}>
                {val ?? 'not set'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
