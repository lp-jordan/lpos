'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type ConfigVolume = {
  rootPath: string;
  enabled: boolean;
  priority: number;
};

type StorageConfig = {
  thresholdPercent: number;
  reserveBytes: number;
  managedRootName: string;
  volumes: ConfigVolume[];
  updatedAt: string | null;
};

type AllocationVolume = {
  rootPath: string;
  label: string;
  totalBytes: number | null;
  freeBytes: number | null;
  available: boolean;
  writable?: boolean;
  enabled?: boolean;
  priority?: number | null;
  managedRoot?: string;
  usedPercent?: number | null;
  eligible?: boolean;
  reason?: string | null;
};

type ConfigResponse = {
  bootstrapped: boolean;
  unlocked: boolean;
  config?: StorageConfig;
  allocation?: {
    active: AllocationVolume | null;
    next?: AllocationVolume | null;
    volumes: AllocationVolume[];
  };
};

type EditableVolume = AllocationVolume & {
  enabled: boolean;
  priority: number;
};

function bytesToHuman(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function reserveBytesFromGb(gb: number): number {
  return Math.max(0, gb) * 1024 * 1024 * 1024;
}

export function StorageSettingsClient() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [thresholdPercent, setThresholdPercent] = useState(90);
  const [reserveGb, setReserveGb] = useState(25);
  const [managedRootName] = useState('LPOS');
  const [volumes, setVolumes] = useState<EditableVolume[]>([]);
  const [activeDrive, setActiveDrive] = useState<AllocationVolume | null>(null);
  const [nextDrive, setNextDrive] = useState<AllocationVolume | null>(null);
  const [hasLoadedConfig, setHasLoadedConfig] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedSignatureRef = useRef<string>('');

  function buildSignature(input: {
    thresholdPercent: number;
    reserveGb: number;
    managedRootName: string;
    volumes: EditableVolume[];
  }): string {
    return JSON.stringify({
      thresholdPercent: input.thresholdPercent,
      reserveGb: input.reserveGb,
      managedRootName: input.managedRootName,
      volumes: [...input.volumes]
        .sort((a, b) => a.priority - b.priority)
        .map((volume) => ({
          rootPath: volume.rootPath,
          enabled: volume.enabled,
          priority: volume.priority,
        })),
    });
  }

  async function loadConfig() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/storage/config', { cache: 'no-store' });
      const data = await res.json() as ConfigResponse;
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Failed to load storage settings.');

      if (data.config && data.allocation) {
        setThresholdPercent(data.config.thresholdPercent);
        setReserveGb(Math.round(data.config.reserveBytes / 1024 / 1024 / 1024));
        const configMap = new Map(data.config.volumes.map((volume) => [volume.rootPath, volume]));
        const merged = data.allocation.volumes.map((volume, index) => {
          const saved = configMap.get(volume.rootPath);
          return {
            ...volume,
            enabled: saved?.enabled ?? false,
            priority: saved?.priority ?? index,
          };
        }).sort((a, b) => a.priority - b.priority);
        setVolumes(merged);
        setActiveDrive(data.allocation.active);
        setNextDrive(data.allocation.next ?? null);
        lastSavedSignatureRef.current = buildSignature({
          thresholdPercent: data.config.thresholdPercent,
          reserveGb: Math.round(data.config.reserveBytes / 1024 / 1024 / 1024),
          managedRootName: data.config.managedRootName,
          volumes: merged,
        });
      } else {
        const merged = (data.allocation?.volumes ?? []).map((volume, index) => ({
          ...volume,
          enabled: false,
          priority: index,
        }));
        setVolumes(merged);
        setActiveDrive(data.allocation?.active ?? null);
        setNextDrive(data.allocation?.next ?? null);
        lastSavedSignatureRef.current = buildSignature({
          thresholdPercent,
          reserveGb,
          managedRootName,
          volumes: merged,
        });
      }
      setHasLoadedConfig(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const enabledCount = useMemo(() => volumes.filter((volume) => volume.enabled).length, [volumes]);

  function updateVolume(rootPath: string, patch: Partial<EditableVolume>) {
    setVolumes((current) => current.map((volume) => (
      volume.rootPath === rootPath ? { ...volume, ...patch } : volume
    )));
  }

  function moveVolume(rootPath: string, direction: -1 | 1) {
    setVolumes((current) => {
      const ordered = [...current].sort((a, b) => a.priority - b.priority);
      const index = ordered.findIndex((volume) => volume.rootPath === rootPath);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= ordered.length) return current;
      const next = [...ordered];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((volume, priority) => ({ ...volume, priority }));
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaveMessage('Saving…');
    try {
      const res = await fetch('/api/storage/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thresholdPercent,
          reserveBytes: reserveBytesFromGb(reserveGb),
          managedRootName,
          volumes: [...volumes]
            .sort((a, b) => a.priority - b.priority)
            .map((volume, priority) => ({
              rootPath: volume.rootPath,
              enabled: volume.enabled,
              priority,
            })),
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Unable to save storage settings.');
      await loadConfig();
      setSaveMessage('Saved');
    } catch (err) {
      setError((err as Error).message);
      setSaveMessage(null);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!hasLoadedConfig || loading) return;
    const currentSignature = buildSignature({
      thresholdPercent,
      reserveGb,
      managedRootName,
      volumes,
    });
    if (currentSignature === lastSavedSignatureRef.current) {
      setSaveMessage('Saved');
      return;
    }
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSaveMessage('Unsaved changes');
    saveTimeoutRef.current = setTimeout(() => {
      void save();
    }, 700);
  }, [thresholdPercent, reserveGb, volumes]);

  if (loading) {
    return (
      <section className="storage-settings-page">
        <div className="storage-settings-card">
          <p className="storage-settings-kicker">Storage</p>
          <h1 className="storage-settings-title">Loading host storage settings…</h1>
        </div>
      </section>
    );
  }

  return (
    <section className="storage-settings-page">
      <div className="storage-settings-hero">
        <div>
          <p className="storage-settings-kicker">Storage</p>
          <h1 className="storage-settings-title">Managed drive allocation</h1>
          <p className="storage-settings-copy">
            LPOS will own the folder structure on each enabled volume and automatically advance to the next drive
            when the current one crosses the configured capacity threshold.
          </p>
        </div>
        <div className="storage-settings-status" aria-live="polite">
          {saving ? 'Saving…' : (saveMessage ?? 'Autosave on')}
        </div>
      </div>

      {error && <div className="storage-settings-error">{error}</div>}

      <div className="storage-settings-grid">
        <div className="storage-settings-card">
          <h2 className="storage-settings-section-title">Allocation</h2>
          <div className="storage-settings-summary">
            <div>
              <span className="storage-settings-label">Active Drive</span>
              <strong>{activeDrive ? `${activeDrive.label} (${activeDrive.rootPath})` : 'None available'}</strong>
            </div>
            <div>
              <span className="storage-settings-label">Next Drive</span>
              <strong>{nextDrive ? `${nextDrive.label} (${nextDrive.rootPath})` : 'No standby drive'}</strong>
            </div>
            <div>
              <span className="storage-settings-label">Threshold</span>
              <strong>{thresholdPercent}% used</strong>
            </div>
            <div>
              <span className="storage-settings-label">Reserve</span>
              <strong>{reserveGb} GB free</strong>
            </div>
          </div>
        </div>

        <div className="storage-settings-card">
          <h2 className="storage-settings-section-title">Thresholds</h2>
          <label className="storage-settings-field">
            <span>Switch when drive usage reaches</span>
            <input
              type="number"
              min={50}
              max={98}
              value={thresholdPercent}
              onChange={(event) => setThresholdPercent(Number(event.target.value))}
            />
          </label>
          <label className="storage-settings-field">
            <span>Minimum free space to keep in reserve (GB)</span>
            <input
              type="number"
              min={0}
              max={5000}
              value={reserveGb}
              onChange={(event) => setReserveGb(Number(event.target.value))}
            />
          </label>
        </div>
      </div>

      <div className="storage-settings-card">
        <div className="storage-settings-card-head">
          <div>
            <h2 className="storage-settings-section-title">Detected volumes</h2>
            <p className="storage-settings-muted">
              LPOS manages its own structure inside each enabled drive at <code>\{managedRootName}</code>.
            </p>
          </div>
          <div className="storage-settings-enabled-count">{enabledCount} enabled</div>
        </div>

        <div className="storage-volume-list">
          {[...volumes].sort((a, b) => a.priority - b.priority).map((volume, index) => (
            <article key={volume.rootPath} className="storage-volume-card">
              <div className="storage-volume-main">
                <div>
                  <div className="storage-volume-title-row">
                    <h3 className="storage-volume-title">{volume.label}</h3>
                    <span className={`storage-volume-chip${volume.eligible ? ' ok' : ''}`}>
                      {volume.eligible ? 'Ready' : volume.reason ?? 'Unavailable'}
                    </span>
                  </div>
                  <p className="storage-volume-path">{volume.rootPath}</p>
                  <p className="storage-volume-meta">
                    {bytesToHuman(volume.freeBytes)} free of {bytesToHuman(volume.totalBytes)}
                    {typeof volume.usedPercent === 'number' ? ` • ${volume.usedPercent.toFixed(1)}% used` : ''}
                  </p>
                </div>
                <label className="storage-volume-toggle">
                  <input
                    type="checkbox"
                    checked={volume.enabled}
                    onChange={(event) => updateVolume(volume.rootPath, { enabled: event.target.checked })}
                  />
                  <span>Enabled</span>
                </label>
              </div>
              <div className="storage-volume-actions">
                <span className="storage-volume-order">Priority #{index + 1}</span>
                <button
                  type="button"
                  className="storage-settings-secondary"
                  onClick={() => moveVolume(volume.rootPath, -1)}
                >
                  Move Up
                </button>
                <button
                  type="button"
                  className="storage-settings-secondary"
                  onClick={() => moveVolume(volume.rootPath, 1)}
                >
                  Move Down
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="storage-settings-actions">
        <button type="button" className="storage-settings-secondary" onClick={() => void loadConfig()}>
          Refresh Volumes
        </button>
      </div>
    </section>
  );
}
