'use client';

/**
 * AddVideosPicker — the share window's "+ Add videos" panel (inside the same
 * window, which widens while it's open). Navigates like the Projects page:
 * All clients → a client's projects → a project's videos, with a breadcrumb to
 * back out and search across everything. Opens in the project you're working in.
 *
 * Selections carry across projects and clients; videos already in the share
 * are marked and can't be picked again. A small red dot marks videos that
 * aren't ready on Cloudflare yet (they'll play once processing finishes).
 */

import { useEffect, useMemo, useState } from 'react';
import type { BrowseClient, BrowseProject, ShareAssetOption } from '@/lib/services/share-links';

type Level =
  | { kind: 'clients' }
  | { kind: 'projects'; client: string }
  | { kind: 'videos'; client: string; projectId: string; projectName: string };

interface Props {
  existing:        Set<string>;
  /** Where to open: the project you came from, or the one most of the share's videos come from. */
  startProjectId?: string | null;
  onAdd:           (items: Array<{ assetId: string; projectId: string }>) => Promise<void>;
  onClose:         () => void;
}

function fmtDuration(s: number | null): string {
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2, '0')}`;
}

export function AddVideosPicker({ existing, startProjectId, onAdd, onClose }: Readonly<Props>) {
  const [level, setLevel] = useState<Level | null>(startProjectId ? null : { kind: 'clients' });
  const [clients, setClients] = useState<BrowseClient[] | null>(null);
  const [projects, setProjects] = useState<BrowseProject[] | null>(null);
  const [videos, setVideos] = useState<ShareAssetOption[] | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ShareAssetOption[] | null>(null);
  const [picked, setPicked] = useState<Map<string, ShareAssetOption>>(new Map());
  const [busy, setBusy] = useState(false);

  // Open inside the starting project (and know its client for the breadcrumb).
  useEffect(() => {
    if (!startProjectId) return;
    fetch(`/api/share-links/browse?projectId=${encodeURIComponent(startProjectId)}`)
      .then((r) => r.json())
      .then((d: { project: BrowseProject | null; videos: ShareAssetOption[] }) => {
        if (!d.project) { setLevel({ kind: 'clients' }); return; }
        setVideos(d.videos);
        setLevel({ kind: 'videos', client: d.project.clientName, projectId: d.project.projectId, projectName: d.project.name });
      })
      .catch(() => setLevel({ kind: 'clients' }));
  }, [startProjectId]);

  // Load whatever the current level needs.
  useEffect(() => {
    if (!level) return;
    if (level.kind === 'clients' && !clients) {
      fetch('/api/share-links/browse').then((r) => r.json()).then((d: { clients: BrowseClient[] }) => setClients(d.clients)).catch(() => setClients([]));
    } else if (level.kind === 'projects') {
      setProjects(null);
      fetch(`/api/share-links/browse?client=${encodeURIComponent(level.client)}`).then((r) => r.json())
        .then((d: { projects: BrowseProject[] }) => setProjects(d.projects)).catch(() => setProjects([]));
    }
  }, [level, clients]);

  function openProject(p: { projectId: string; name: string; clientName: string }) {
    setVideos(null);
    setLevel({ kind: 'videos', client: p.clientName, projectId: p.projectId, projectName: p.name });
    fetch(`/api/share-links/browse?projectId=${encodeURIComponent(p.projectId)}`).then((r) => r.json())
      .then((d: { videos: ShareAssetOption[] }) => setVideos(d.videos)).catch(() => setVideos([]));
  }

  // Search across everything (switches to flat results while there's a query).
  useEffect(() => {
    if (!q.trim()) { setResults(null); return; }
    const t = setTimeout(() => {
      fetch(`/api/share-links/assets?q=${encodeURIComponent(q)}`).then((r) => r.json())
        .then((d: { assets?: ShareAssetOption[] }) => setResults(d.assets ?? [])).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  function toggle(a: ShareAssetOption) {
    if (existing.has(a.assetId)) return;
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(a.assetId)) next.delete(a.assetId); else next.set(a.assetId, a);
      return next;
    });
  }

  const shown = results ?? (level?.kind === 'videos' ? videos : null);
  const selectable = useMemo(() => (shown ?? []).filter((a) => !existing.has(a.assetId)), [shown, existing]);
  const allPicked = selectable.length > 0 && selectable.every((a) => picked.has(a.assetId));
  function toggleAll() {
    setPicked((prev) => {
      const next = new Map(prev);
      for (const a of selectable) { if (allPicked) next.delete(a.assetId); else next.set(a.assetId, a); }
      return next;
    });
  }

  async function add() {
    setBusy(true);
    await onAdd([...picked.values()].map((a) => ({ assetId: a.assetId, projectId: a.projectId })));
    setBusy(false);
  }

  const crumbs: Array<{ label: string; go?: () => void }> = [{ label: 'All clients', go: level?.kind !== 'clients' || results ? () => { setQ(''); setLevel({ kind: 'clients' }); } : undefined }];
  if (level && level.kind !== 'clients') crumbs.push({ label: level.client, go: level.kind === 'videos' || results ? () => { setQ(''); setLevel({ kind: 'projects', client: level.client }); } : undefined });
  if (level?.kind === 'videos') crumbs.push({ label: level.projectName, go: results ? () => setQ('') : undefined });

  return (
    <div className="shp">
      <div className="shp-top">
        <nav className="shp-crumbs" aria-label="Location">
          {crumbs.map((c, i) => (
            <span key={c.label + i} className="shp-crumb">
              {i > 0 && <span className="shp-sep" aria-hidden="true">›</span>}
              {c.go ? <button type="button" onClick={c.go}>{c.label}</button> : <span aria-current="page">{c.label}</span>}
            </span>
          ))}
        </nav>
        <input className="shp-search" placeholder="Search all videos" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search all videos"
          onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
      </div>

      <div className="shp-body">
        {shown ? (
          <>
            <div className="shp-bar">
              <span className="shp-count">{results ? `${results.length} result${results.length === 1 ? '' : 's'}` : `${shown.length} video${shown.length === 1 ? '' : 's'}`}</span>
              {selectable.length > 0 && <button type="button" className="shp-link" onClick={toggleAll}>{allPicked ? 'Clear these' : 'Select all'}</button>}
            </div>
            {shown.length === 0 ? <p className="shp-empty">{results ? 'No videos match.' : 'No videos in this project.'}</p> : (
              <div className="shp-videos">
                {shown.map((a) => {
                  const inShare = existing.has(a.assetId);
                  const on = picked.has(a.assetId);
                  return (
                    <button key={a.assetId} type="button" className={`shp-video${on ? ' is-on' : ''}${inShare ? ' is-in' : ''}`}
                      onClick={() => toggle(a)} disabled={inShare} aria-pressed={on}>
                      <span className="shp-thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.thumbnailUrl} alt="" loading="lazy" />
                        <span className="shp-check" aria-hidden="true">{on || inShare ? '✓' : ''}</span>
                        {!a.cfReady && <span className="shp-notready" title="Not ready on Cloudflare yet — it will play once processing finishes" aria-label="Not ready on Cloudflare yet" />}
                        {a.duration ? <span className="shp-dur">{fmtDuration(a.duration)}</span> : null}
                      </span>
                      <span className="shp-vtitle">{a.platformTitle ?? a.name}</span>
                      <span className="shp-vsub">{inShare ? 'In share' : results ? `${a.clientName} · ${a.projectName}` : a.platformTitle ? a.name : ''}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : level?.kind === 'clients' ? (
          !clients ? <p className="shp-empty">Loading…</p> : (
            <div className="shp-cards">
              {clients.map((c) => (
                <button key={c.clientName} type="button" className="shp-card" onClick={() => setLevel({ kind: 'projects', client: c.clientName })}>
                  <span className="shp-initial">{c.clientName.charAt(0).toUpperCase()}</span>
                  <span className="shp-card-text">
                    <span className="shp-card-name">{c.clientName}</span>
                    <span className="shp-card-meta">{c.projectCount} project{c.projectCount === 1 ? '' : 's'} · {c.videoCount ? `${c.videoCount} video${c.videoCount === 1 ? '' : 's'}` : 'No videos'}</span>
                  </span>
                </button>
              ))}
            </div>
          )
        ) : level?.kind === 'projects' ? (
          !projects ? <p className="shp-empty">Loading…</p> : projects.length === 0 ? <p className="shp-empty">No projects.</p> : (
            <div className="shp-cards">
              {projects.map((p) => (
                <button key={p.projectId} type="button" className="shp-card" onClick={() => openProject(p)} disabled={!p.videoCount}>
                  <span className="shp-initial">{p.name.charAt(0).toUpperCase()}</span>
                  <span className="shp-card-text">
                    <span className="shp-card-name">{p.name}</span>
                    <span className="shp-card-meta">{p.videoCount ? `${p.videoCount} video${p.videoCount === 1 ? '' : 's'}` : 'No videos'}</span>
                  </span>
                </button>
              ))}
            </div>
          )
        ) : <p className="shp-empty">Loading…</p>}
      </div>

      <div className="shp-foot">
        <span className="shp-count">{picked.size ? `${picked.size} selected` : 'Pick videos from any project'}</span>
        {picked.size > 0 && <button type="button" className="shp-link" onClick={() => setPicked(new Map())}>Clear</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="modal-btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="modal-btn-primary" disabled={!picked.size || busy} onClick={() => void add()}>
          {picked.size ? `Add ${picked.size} video${picked.size === 1 ? '' : 's'}` : 'Add videos'}
        </button>
      </div>
    </div>
  );
}
