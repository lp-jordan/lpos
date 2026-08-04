'use client';

import { useEffect, useState } from 'react';

export type MediaSelection =
  | { kind: 'video'; projectId: string; assetId: string }
  | { kind: 'link'; url: string; title: string };

interface ProjectRow { projectId: string; name: string; clientName: string; assetCount: number }
interface AssetRow { assetId: string; name: string; durationSec: number | null; thumbUrl: string | null; ready: boolean }

function fmtDur(s: number | null): string {
  if (s == null) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function MediaPicker({ onPick, onClose, defaultProjectId }: { onPick: (sel: MediaSelection) => void; onClose: () => void; defaultProjectId?: string | null }) {
  const [tab, setTab] = useState<'project' | 'link'>('project');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [query, setQuery] = useState('');
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [url, setUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');

  useEffect(() => {
    fetch('/api/platform/media/projects').then((r) => r.ok ? r.json() : { projects: [] }).then((d) => setProjects(d.projects ?? []));
    if (defaultProjectId) openProject(defaultProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openProject(projectId: string) {
    setActiveProject(projectId);
    setLoadingAssets(true);
    const res = await fetch(`/api/platform/media/assets?projectId=${encodeURIComponent(projectId)}`);
    setAssets(res.ok ? (await res.json()).assets : []);
    setLoadingAssets(false);
  }

  const filtered = projects.filter((p) =>
    !query || `${p.name} ${p.clientName}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <div onClick={onClose} style={scrimBg} />
      <div style={modal}>
        <div style={head}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => setTab('project')} style={{ ...tabBtn, ...(tab === 'project' ? tabOn : {}) }}>Project media</button>
            <button onClick={() => setTab('link')} style={{ ...tabBtn, ...(tab === 'link' ? tabOn : {}) }}>External link</button>
          </div>
          <button onClick={onClose} style={iconBtn}>✕</button>
        </div>

        {tab === 'project' ? (
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div style={projCol}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects…" style={{ ...input, margin: '0 0 8px' }} />
              <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {filtered.map((p) => (
                  <button key={p.projectId} onClick={() => openProject(p.projectId)}
                    style={{ ...projRow, ...(activeProject === p.projectId ? projRowOn : {}) }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--muted-soft)' }}>{p.clientName} · {p.assetCount}</span>
                  </button>
                ))}
                {filtered.length === 0 && <div style={{ padding: 12, color: 'var(--muted-soft)', fontSize: 12 }}>No projects.</div>}
              </div>
            </div>
            <div style={assetCol}>
              {!activeProject && <div style={{ color: 'var(--muted-soft)', fontSize: 13, padding: 20 }}>Select a project to see its media.</div>}
              {activeProject && loadingAssets && <div style={{ color: 'var(--muted-soft)', fontSize: 13, padding: 20 }}>Loading…</div>}
              {activeProject && !loadingAssets && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                  {assets.map((a) => (
                    <button key={a.assetId} onClick={() => onPick({ kind: 'video', projectId: activeProject, assetId: a.assetId })} style={assetCard}>
                      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 8, overflow: 'hidden', background: 'var(--surface-inset)' }}>
                        {a.thumbUrl
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={a.thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted-soft)', fontSize: 20 }}>▤</div>}
                        {a.durationSec != null && <span style={durPill}>{fmtDur(a.durationSec)}</span>}
                        {!a.ready && <span style={notReadyPill}>no stream</span>}
                      </div>
                      <span style={{ fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', textAlign: 'left' }}>{a.name}</span>
                    </button>
                  ))}
                  {assets.length === 0 && <div style={{ color: 'var(--muted-soft)', fontSize: 12 }}>No media in this project.</div>}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={label}>Link URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={input} autoFocus />
            <label style={label}>Label (optional)</label>
            <input value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} placeholder="Shown on the tile" style={input} />
            <button
              onClick={() => url.trim() && onPick({ kind: 'link', url: url.trim(), title: linkTitle.trim() || url.trim() })}
              disabled={!url.trim()} style={{ ...primaryBtn, opacity: url.trim() ? 1 : 0.5, alignSelf: 'flex-start' }}>
              Link this URL
            </button>
          </div>
        )}
      </div>
    </>
  );
}

const scrimBg: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 50 };
const modal: React.CSSProperties = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 720, maxWidth: '94vw', height: 520, maxHeight: '88vh', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, zIndex: 51, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' };
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--line)' };
const tabBtn: React.CSSProperties = { border: '1px solid var(--line)', background: 'var(--surface-inset)', color: 'var(--muted)', fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' };
const tabOn: React.CSSProperties = { color: 'var(--text-strong)', borderColor: 'var(--accent)', background: 'var(--accent-soft)' };
const iconBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-raised)', color: 'var(--muted)', fontSize: 14, cursor: 'pointer' };
const projCol: React.CSSProperties = { width: 220, flexShrink: 0, borderRight: '1px solid var(--line)', padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0 };
const assetCol: React.CSSProperties = { flex: 1, padding: 16, overflowY: 'auto' };
const projRow: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start', textAlign: 'left', padding: '7px 9px', borderRadius: 7, border: '1px solid transparent', background: 'transparent', cursor: 'pointer' };
const projRowOn: React.CSSProperties = { background: 'var(--surface-inset)', borderColor: 'var(--line)' };
const assetCard: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start', background: 'transparent', border: '1px solid var(--line)', borderRadius: 10, padding: 8, cursor: 'pointer' };
const durPill: React.CSSProperties = { position: 'absolute', bottom: 5, right: 5, fontSize: 10, fontFamily: 'ui-monospace, Menlo, monospace', color: '#fff', background: 'rgba(0,0,0,.6)', padding: '1px 5px', borderRadius: 4 };
const notReadyPill: React.CSSProperties = { position: 'absolute', top: 5, left: 5, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--warning)', background: 'rgba(0,0,0,.55)', padding: '2px 5px', borderRadius: 4 };
const input: React.CSSProperties = { background: 'var(--surface-inset)', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 8, padding: '8px 11px', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%' };
const label: React.CSSProperties = { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted-soft)', fontWeight: 700 };
const primaryBtn: React.CSSProperties = { background: 'var(--accent)', color: '#1a1206', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
