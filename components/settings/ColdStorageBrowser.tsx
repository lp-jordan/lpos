'use client';

import { useCallback, useEffect, useState } from 'react';

interface Folder { prefix: string; name: string }
interface FileEntry {
  key:          string;
  name:         string;
  size:         number;
  lastModified: string | null;
}

interface BrowseResponse {
  prefix:  string;
  folders: Folder[];
  files:   FileEntry[];
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

interface Crumb { label: string; prefix: string }

function buildCrumbs(prefix: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Bucket root', prefix: '' }];
  if (!prefix) return crumbs;
  const parts = prefix.replace(/\/$/, '').split('/');
  let running = '';
  for (const p of parts) {
    running += `${p}/`;
    crumbs.push({ label: p, prefix: running });
  }
  return crumbs;
}

interface Props {
  credsOk: boolean;
}

export function ColdStorageBrowser({ credsOk }: Props) {
  const [open, setOpen]       = useState(false);
  const [prefix, setPrefix]   = useState('');
  const [data, setData]       = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/cold-storage/browse?prefix=${encodeURIComponent(p)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'List failed');
      }
      const json = await res.json() as BrowseResponse;
      setData(json);
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(prefix);
  }, [open, prefix, load]);

  async function deleteOne(key: string) {
    if (!confirm(`Delete ${key} from the cold-storage bucket?\n\nIf its source file still exists, the next sync will re-upload it.`)) return;
    setBusy(key);
    try {
      const res = await fetch(`/api/admin/cold-storage/objects?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Delete failed');
      }
      await load(prefix);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function deleteFolder(p: string) {
    if (!confirm(`Delete every object under "${p}"?\n\nThis cannot be undone from the B2 side, but anything still present in source will be re-uploaded on the next sync.`)) return;
    setBusy(p);
    try {
      const res = await fetch(`/api/admin/cold-storage/objects?prefix=${encodeURIComponent(p)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Folder delete failed');
      }
      await load(prefix);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!credsOk) return null;

  return (
    <div className="cold-storage-browser">
      <div className="cold-storage-browser-head">
        <h3 className="storage-settings-section-title" style={{ fontSize: '1em', margin: 0 }}>
          Bucket browser
        </h3>
        <button
          type="button"
          className="storage-settings-secondary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {/* Breadcrumb */}
          <div className="cold-storage-crumbs">
            {buildCrumbs(prefix).map((c, i, arr) => (
              <span key={c.prefix}>
                <button
                  type="button"
                  className="cold-storage-crumb"
                  onClick={() => setPrefix(c.prefix)}
                  disabled={c.prefix === prefix}
                >
                  {c.label}
                </button>
                {i < arr.length - 1 && <span className="cold-storage-crumb-sep">/</span>}
              </span>
            ))}
            <button
              type="button"
              className="storage-settings-secondary"
              onClick={() => void load(prefix)}
              disabled={loading}
              style={{ marginLeft: 'auto' }}
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {error && (
            <p className="storage-settings-muted" style={{ color: '#ffb4ab', marginTop: 8 }}>{error}</p>
          )}

          {!loading && data && (
            <div className="cold-storage-browser-list">
              {data.folders.length === 0 && data.files.length === 0 && (
                <p className="storage-settings-muted" style={{ fontSize: '0.9em' }}>Empty.</p>
              )}

              {data.folders.map((f) => (
                <div key={f.prefix} className="cold-storage-browser-row">
                  <button
                    type="button"
                    className="cold-storage-browser-folder"
                    onClick={() => setPrefix(f.prefix)}
                  >
                    📁 {f.name}
                  </button>
                  <span className="cold-storage-meta" />
                  <button
                    type="button"
                    className="cold-storage-delete-btn"
                    onClick={() => void deleteFolder(f.prefix)}
                    disabled={busy === f.prefix}
                  >
                    {busy === f.prefix ? '…' : 'Delete folder'}
                  </button>
                </div>
              ))}

              {data.files.map((file) => (
                <div key={file.key} className="cold-storage-browser-row">
                  <span className="cold-storage-browser-file">📄 {file.name}</span>
                  <span className="cold-storage-meta">
                    {bytesToHuman(file.size)}
                    {file.lastModified ? ` · ${new Date(file.lastModified).toLocaleDateString()}` : ''}
                  </span>
                  <button
                    type="button"
                    className="cold-storage-delete-btn"
                    onClick={() => void deleteOne(file.key)}
                    disabled={busy === file.key}
                  >
                    {busy === file.key ? '…' : 'Delete'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
