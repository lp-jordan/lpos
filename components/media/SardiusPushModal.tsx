'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';
import type { SardiusFolder, SardiusFolderMetadata } from '@/lib/services/sardius-ftp';

const PUBLISH_PROFILES = ['hls-enhanced', 'hls', 'mp4', 'mp4-enhanced', 'import', 'audio'] as const;

interface Props {
  assets: MediaAsset[];
  projectId: string;
  onClose: () => void;
  onPushed: () => void;
}

function splitTags(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function pathSegments(p: string): string[] {
  return p.split('/').filter(Boolean);
}

function lastSegment(p: string): string {
  const segs = pathSegments(p);
  return segs[segs.length - 1] ?? '';
}

export function SardiusPushModal({ assets, projectId, onClose, onPushed }: Readonly<Props>) {
  const [currentPath, setCurrentPath]       = useState('/');
  const [folders, setFolders]               = useState<SardiusFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [foldersError, setFoldersError]     = useState<string | null>(null);
  const [existingJson, setExistingJson]     = useState<SardiusFolderMetadata | null>(null);

  const [newFolderActive, setNewFolderActive] = useState(false);
  const [newFolderName, setNewFolderName]     = useState('');
  const [newFolderSaving, setNewFolderSaving] = useState(false);
  const [newFolderError, setNewFolderError]   = useState<string | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  const defaultSpeakers = assets.length === 1 ? assets[0].name : '';
  const [speakers, setSpeakers]             = useState(defaultSpeakers);
  const [categories, setCategories]         = useState('');
  const [publishProfile, setPublishProfile] = useState('hls-enhanced');

  const [pushing, setPushing]       = useState(false);
  const [pushProgress, setPushProgress] = useState(0);
  const [pushError, setPushError]   = useState<string | null>(null);

  // Filename collision state
  const [conflict, setConflict] = useState<{
    asset: MediaAsset;
    suggestedName: string;
    remaining: MediaAsset[];
    done: number;
  } | null>(null);

  const speakerList  = splitTags(speakers);
  const categoryList = splitTags(categories);

  // Only show sidecar preview for single-asset pushes
  const singleAsset = assets.length === 1 ? assets[0] : null;
  const sidecarPreview = JSON.stringify(
    { speakers: speakerList, categories: categoryList, publishProfile },
    null,
    2,
  );

  const loadFolders = useCallback(async (path: string) => {
    setFoldersLoading(true);
    setFoldersError(null);
    setExistingJson(null);
    setNewFolderActive(false);
    setNewFolderName('');
    try {
      const res  = await fetch(`/api/sardius/folders?path=${encodeURIComponent(path)}`);
      const data = await res.json() as {
        folders?: SardiusFolder[];
        folderMetadata?: SardiusFolderMetadata | null;
        error?: string;
      };
      if (!res.ok) { setFoldersError(data.error ?? 'Failed to load folders'); return; }
      setFolders(data.folders ?? []);

      if (path !== '/') {
        const folderName = lastSegment(path);
        // Auto-fill categories from folder name; speakers from existing JSON if found
        setCategories(folderName);
        if (data.folderMetadata) {
          setExistingJson(data.folderMetadata);
          setSpeakers(data.folderMetadata.speakers.join(', '));
          setPublishProfile(data.folderMetadata.publishProfile);
        }
      } else {
        setCategories('');
      }
    } catch {
      setFoldersError('Network error — could not reach LPOS server');
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  useEffect(() => { void loadFolders('/'); }, []);

  function navigateTo(path: string) {
    setCurrentPath(path);
    void loadFolders(path);
  }

  function navigateToSegment(index: number) {
    const segs = pathSegments(currentPath);
    const path = index < 0 ? '/' : '/' + segs.slice(0, index + 1).join('/');
    navigateTo(path);
  }

  function activateNewFolder() {
    setNewFolderActive(true);
    setNewFolderName('');
    setNewFolderError(null);
    setTimeout(() => newFolderInputRef.current?.focus(), 0);
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    const fullPath = `${currentPath.replace(/\/$/, '')}/${name}`;
    setNewFolderSaving(true);
    setNewFolderError(null);
    try {
      const res  = await fetch('/api/sardius/folders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path: fullPath }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setNewFolderError(data.error ?? 'Failed to create folder'); return; }
      navigateTo(fullPath);
    } catch {
      setNewFolderError('Network error');
    } finally {
      setNewFolderSaving(false);
    }
  }

  async function pushAssets(
    queue: MediaAsset[],
    startDone: number,
    total: number,
    extra: { overwrite?: boolean; filenameOverride?: string } = {},
  ) {
    let done = startDone;
    for (const a of queue) {
      try {
        const res = await fetch(`/api/projects/${projectId}/media/${a.assetId}/sardius`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            remoteDir: currentPath,
            metadata:  { speakers: speakerList, categories: categoryList, publishProfile },
            ...extra,
          }),
        });
        const data = await res.json() as { error?: string; conflict?: boolean; suggestedName?: string };
        if (res.status === 409 && data.conflict) {
          // Pause loop — let user resolve conflict for this asset
          const remaining = queue.slice(queue.indexOf(a) + 1);
          setConflict({ asset: a, suggestedName: data.suggestedName ?? '', remaining, done });
          setPushing(false);
          return;
        }
        if (!res.ok) { setPushError(`${a.name}: ${data.error ?? 'failed'}`); setPushing(false); return; }
        done++;
        setPushProgress(Math.round((done / total) * 100));
      } catch {
        setPushError(`${a.name}: network error`);
        setPushing(false);
        return;
      }
    }
    onPushed();
  }

  async function handlePush() {
    if (!currentPath || currentPath === '/') return;
    setPushError(null);
    setConflict(null);
    setPushing(true);
    setPushProgress(0);
    const pushable = assets.filter((a) => a.filePath);
    await pushAssets(pushable, 0, pushable.length);
  }

  async function handleResolveConflict(choice: 'overwrite' | 'rename') {
    if (!conflict) return;
    setPushing(true);
    setPushError(null);
    const { asset, suggestedName, remaining, done } = conflict;
    setConflict(null);
    const total = assets.filter((a) => a.filePath).length;
    const extra = choice === 'overwrite'
      ? { overwrite: true }
      : { filenameOverride: suggestedName };
    await pushAssets([asset, ...remaining], done, total, extra);
  }

  const segments  = pathSegments(currentPath);
  const canPush   = currentPath !== '/' && !pushing && !conflict;
  const skipCount = assets.filter((a) => !a.filePath).length;

  return (
    <>
      <div className="sardius-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sardius-modal" role="dialog" aria-label="Push to Sardius" aria-modal="true">

        <div className="sardius-modal-header">
          <span className="sardius-modal-title">
            Push to Sardius
            {assets.length > 1 && (
              <span className="sardius-modal-count"> — {assets.length} assets</span>
            )}
          </span>
          <button type="button" className="mad-close-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="sardius-modal-body">

          {/* Folder browser */}
          <div className="sardius-section">
            <div className="sardius-browser-toolbar">
              <div className="sardius-breadcrumb">
                <button
                  type="button"
                  className="sardius-crumb"
                  onClick={() => navigateToSegment(-1)}
                  disabled={currentPath === '/'}
                >
                  /
                </button>
                {segments.map((seg, i) => (
                  <span key={i} className="sardius-crumb-wrap">
                    <span className="sardius-crumb-sep">›</span>
                    <button
                      type="button"
                      className={`sardius-crumb${i === segments.length - 1 ? ' sardius-crumb--active' : ''}`}
                      onClick={() => navigateToSegment(i)}
                    >
                      {seg}
                    </button>
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="mad-action-btn sardius-new-folder-btn"
                onClick={activateNewFolder}
                disabled={foldersLoading}
                title="New folder here"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
                </svg>
                New Folder
              </button>
            </div>

            {newFolderActive && (
              <div className="sardius-new-folder-row">
                <input
                  ref={newFolderInputRef}
                  className="mad-field-input sardius-new-folder-input"
                  type="text"
                  placeholder="Folder name"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')  { e.preventDefault(); void handleCreateFolder(); }
                    if (e.key === 'Escape') { setNewFolderActive(false); }
                  }}
                />
                <button
                  type="button"
                  className="mad-action-btn mad-action-btn--primary"
                  onClick={() => void handleCreateFolder()}
                  disabled={newFolderSaving || !newFolderName.trim()}
                >
                  {newFolderSaving ? '…' : 'Create'}
                </button>
                <button type="button" className="mad-action-btn" onClick={() => setNewFolderActive(false)} disabled={newFolderSaving}>
                  Cancel
                </button>
                {newFolderError && <p className="mad-error sardius-new-folder-error">{newFolderError}</p>}
              </div>
            )}

            {foldersLoading && <p className="sardius-hint">Loading…</p>}
            {foldersError && (
              <div className="sardius-error-row">
                <p className="mad-error">{foldersError}</p>
                <button type="button" className="mad-action-btn" onClick={() => void loadFolders(currentPath)}>Retry</button>
              </div>
            )}
            {!foldersLoading && !foldersError && folders.length === 0 && (
              <p className="sardius-hint sardius-hint--empty">No subfolders here.</p>
            )}
            {!foldersLoading && !foldersError && folders.length > 0 && (
              <ul className="sardius-folder-list">
                {folders.map((folder) => (
                  <li key={folder.path}>
                    <button type="button" className="sardius-folder-item" onClick={() => navigateTo(folder.path)}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                        <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/>
                      </svg>
                      {folder.name}
                      <svg className="sardius-folder-chevron-right" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {currentPath !== '/' && (
              <p className="sardius-selected-path">
                Upload destination: <code>{currentPath}/</code>
              </p>
            )}
          </div>

          {/* Metadata */}
          <div className="sardius-section">
            <div className="sardius-section-head-row">
              <span className="sardius-section-label">Metadata</span>
              {existingJson && (
                <span className="sardius-json-found-badge">JSON found — pre-filled</span>
              )}
            </div>
            <div className="mad-field">
              <label className="mad-field-label">
                Speakers <span className="sardius-label-hint">(comma-separated)</span>
              </label>
              <input
                className="mad-field-input"
                type="text"
                value={speakers}
                onChange={(e) => setSpeakers(e.target.value)}
                placeholder="Ken Hartley, Jane Smith"
              />
            </div>
            <div className="mad-field">
              <label className="mad-field-label">
                Categories <span className="sardius-label-hint">(comma-separated)</span>
              </label>
              <input
                className="mad-field-input"
                type="text"
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
                placeholder="Folder name"
              />
            </div>
            <div className="mad-field">
              <label className="mad-field-label">Publish profile</label>
              <select className="mad-field-input" value={publishProfile} onChange={(e) => setPublishProfile(e.target.value)}>
                {PUBLISH_PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          {/* JSON sidecar preview (single asset only) */}
          {singleAsset && (
            <div className="sardius-section">
              <span className="sardius-section-label">JSON sidecar</span>
              <pre className="sardius-json-preview">{sidecarPreview}</pre>
              <p className="sardius-hint">
                Uploaded alongside the video as <code>{singleAsset.originalFilename.replace(/\.[^.]+$/, '')}.json</code>
              </p>
            </div>
          )}

          {skipCount > 0 && (
            <p className="sardius-hint" style={{ padding: '0 18px 12px' }}>
              {skipCount} asset{skipCount !== 1 ? 's' : ''} will be skipped (no local file path).
            </p>
          )}

          {pushing && assets.length > 1 && (
            <p className="sardius-hint" style={{ padding: '0 18px 12px' }}>
              Queuing uploads… {pushProgress}%
            </p>
          )}

          {conflict && (
            <div className="sardius-conflict-banner">
              <p className="sardius-conflict-msg">
                <strong>{conflict.asset.originalFilename}</strong> already exists in this folder.
              </p>
              <div className="sardius-conflict-actions">
                <button
                  type="button"
                  className="mad-action-btn mad-action-btn--danger"
                  onClick={() => void handleResolveConflict('overwrite')}
                >
                  Overwrite
                </button>
                <button
                  type="button"
                  className="mad-action-btn mad-action-btn--primary"
                  onClick={() => void handleResolveConflict('rename')}
                >
                  Rename to {conflict.suggestedName}
                </button>
              </div>
            </div>
          )}

          {pushError && <p className="mad-error" style={{ margin: '0 20px 12px' }}>{pushError}</p>}
        </div>

        <div className="sardius-modal-footer">
          <button type="button" className="mad-action-btn" onClick={onClose} disabled={pushing}>
            Cancel
          </button>
          {!conflict && (
            <button
              type="button"
              className="mad-action-btn mad-action-btn--primary"
              onClick={() => void handlePush()}
              disabled={!canPush}
              title={currentPath === '/' ? 'Navigate into a folder first' : undefined}
            >
              {pushing
                ? <><span className="mad-spinner mad-spinner--sm" aria-hidden="true" /> Uploading…</>
                : `Push here`}
            </button>
          )}
        </div>

      </div>
    </>
  );
}
