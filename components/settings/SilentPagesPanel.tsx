'use client';

import { useCallback, useEffect, useState } from 'react';
import { isBrowserPlayable, type SilentPageSlug } from '@/lib/silent-pages';

/**
 * Admin picker for the three silent display pages. Each row shows what a page
 * is currently looping and lets an admin re-point it at any local asset without
 * a redeploy.
 */

interface SilentPageRow {
  slug:        SilentPageSlug;
  label:       string;
  path:        string;
  projectId:   string | null;
  projectName: string | null;
  assetId:     string | null;
  assetName:   string | null;
  playable:    boolean;
  missing:     boolean;
}

interface ProjectOption {
  projectId:  string;
  name:       string;
  clientName: string;
  archived?:  boolean;
}

interface AssetOption {
  assetId:          string;
  name:             string;
  filePath:         string | null;
  originalFilename: string;
  mimeType:         string | null;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.45rem 0.6rem',
  borderRadius: 6,
  background: 'var(--color-surface, rgba(0,0,0,0.3))',
  border: '1px solid var(--color-border, rgba(255,255,255,0.12))',
  color: 'var(--color-text, #fff)',
  fontSize: '0.85rem',
};

export function SilentPagesPanel() {
  const [pages, setPages] = useState<SilentPageRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Which row is expanded into edit mode; null when all are collapsed. */
  const [editing, setEditing] = useState<SilentPageSlug | null>(null);
  const [draftProjectId, setDraftProjectId] = useState('');
  const [draftAssetId, setDraftAssetId] = useState('');
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/silent-pages', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load silent pages.');
      const data = await res.json() as { pages: SilentPageRow[] };
      setPages(data.pages);
    } catch {
      setError('Could not load silent page settings.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/projects', { cache: 'no-store' });
        const data = await res.json() as { projects: ProjectOption[] };
        setProjects((data.projects ?? []).filter((p) => !p.archived));
      } catch { /* picker just shows an empty list */ }
    })();
  }, []);

  // Load the chosen project's assets whenever the draft project changes.
  useEffect(() => {
    if (!draftProjectId) { setAssets([]); return; }
    let cancelled = false;
    setAssetsLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${draftProjectId}/media`, { cache: 'no-store' });
        const data = await res.json() as { assets?: AssetOption[] };
        if (cancelled) return;
        // Only locally-streamable assets are candidates — the stream route
        // serves from disk, so anything without a filePath can't play.
        setAssets((data.assets ?? []).filter((a) => a.filePath));
      } catch {
        if (!cancelled) setAssets([]);
      } finally {
        if (!cancelled) setAssetsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [draftProjectId]);

  function beginEdit(row: SilentPageRow) {
    setEditing(row.slug);
    setDraftProjectId(row.projectId ?? '');
    setDraftAssetId(row.assetId ?? '');
    setError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setDraftProjectId('');
    setDraftAssetId('');
  }

  async function save(slug: SilentPageSlug) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/silent-pages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, projectId: draftProjectId, assetId: draftAssetId }),
      });
      const data = await res.json() as { page?: SilentPageRow; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save.');
      if (data.page) setPages((prev) => prev?.map((p) => p.slug === slug ? data.page! : p) ?? prev);
      cancelEdit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function clear(slug: SilentPageSlug) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/silent-pages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, clear: true }),
      });
      const data = await res.json() as { page?: SilentPageRow; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to clear.');
      if (data.page) setPages((prev) => prev?.map((p) => p.slug === slug ? data.page! : p) ?? prev);
      cancelEdit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const draftAsset = assets.find((a) => a.assetId === draftAssetId);
  const draftUnplayable = Boolean(draftAsset && !isBrowserPlayable(draftAsset.filePath ?? draftAsset.originalFilename));

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Silent pages</h2>
        <p className="storage-settings-muted">
          Three unlisted full-screen pages that loop one asset on mute, forever — built for
          display screens. They don&apos;t appear in any menu; point the display device
          straight at the URL. Viewers still need to be signed in to LPOS.
        </p>
      </div>

      {error && (
        <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </p>
      )}

      {!pages && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}

      {pages && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
          {pages.map((row) => (
            <div
              key={row.slug}
              style={{
                border: '1px solid var(--color-border, rgba(255,255,255,0.12))',
                borderRadius: 8,
                padding: '0.75rem 0.9rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{row.label}</div>
                  <code style={{ fontSize: '0.75rem', opacity: 0.7 }}>{row.path}</code>
                  <div style={{ fontSize: '0.8rem', marginTop: 4 }}>
                    {row.assetId ? (
                      <>
                        <span>{row.assetName ?? 'Unknown asset'}</span>
                        {row.projectName && (
                          <span style={{ opacity: 0.6 }}> — {row.projectName}</span>
                        )}
                        {row.missing && (
                          <span style={{ color: 'var(--color-error, #e55)' }}> · asset no longer exists</span>
                        )}
                        {!row.missing && !row.playable && (
                          <span style={{ color: 'var(--color-warning, #e5a04a)' }}> · may not play in a browser</span>
                        )}
                      </>
                    ) : (
                      <span className="storage-settings-muted">Nothing selected</span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  {editing === row.slug ? (
                    <button type="button" className="storage-settings-secondary" onClick={cancelEdit} disabled={saving}>
                      Cancel
                    </button>
                  ) : (
                    <>
                      <button type="button" className="storage-settings-secondary" onClick={() => beginEdit(row)}>
                        {row.assetId ? 'Change' : 'Select'}
                      </button>
                      {row.assetId && (
                        <button type="button" className="storage-settings-secondary" onClick={() => void clear(row.slug)} disabled={saving}>
                          Clear
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {editing === row.slug && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.75rem' }}>
                  <div>
                    <label htmlFor={`sp-project-${row.slug}`} style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>
                      Project
                    </label>
                    <select
                      id={`sp-project-${row.slug}`}
                      value={draftProjectId}
                      onChange={(e) => { setDraftProjectId(e.target.value); setDraftAssetId(''); }}
                      style={inputStyle}
                    >
                      <option value="">Choose a project…</option>
                      {projects.map((p) => (
                        <option key={p.projectId} value={p.projectId}>
                          {p.clientName ? `${p.clientName} — ${p.name}` : p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor={`sp-asset-${row.slug}`} style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: 4 }}>
                      Asset
                    </label>
                    <select
                      id={`sp-asset-${row.slug}`}
                      value={draftAssetId}
                      onChange={(e) => setDraftAssetId(e.target.value)}
                      style={inputStyle}
                      disabled={!draftProjectId || assetsLoading}
                    >
                      <option value="">
                        {assetsLoading ? 'Loading…' : draftProjectId ? 'Choose an asset…' : 'Choose a project first'}
                      </option>
                      {assets.map((a) => {
                        const ok = isBrowserPlayable(a.filePath ?? a.originalFilename);
                        return (
                          <option key={a.assetId} value={a.assetId}>
                            {a.name}{ok ? '' : ' (may not play)'}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {draftUnplayable && (
                    <p style={{ fontSize: '0.8rem', color: 'var(--color-warning, #e5a04a)' }}>
                      Browsers only reliably decode MP4/M4V/WebM. This file may show a black
                      screen. Use an H.264 MP4 export where possible.
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <button
                      type="button"
                      className="storage-settings-primary"
                      onClick={() => void save(row.slug)}
                      disabled={saving || !draftProjectId || !draftAssetId}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
