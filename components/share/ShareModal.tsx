'use client';

/**
 * ShareModal — manage one share: its link, switches, who can open it, its
 * videos and Revoke. Every change is live — no save or deliver step. The same
 * modal is opened from the Platform pass
 * page, the Media tab and the project's Shares list.
 *
 * Also exports the client helpers that create shares, so every entry point
 * creates them the same way (one click → link copied → this modal opens).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { ShareCaps, ShareLink, ShareAudience } from '@/lib/store/share-links-db';
import type { ShareView, ShareViewItem } from '@/lib/services/share-links';
import { AddVideosPicker } from './AddVideosPicker';
import { ViewToggle, useViewMode } from './ViewToggle';

// Internal isn't a switch here: choosing "LP Staff Only" under Who is what
// makes a share internal (the store keeps caps.internal in step with it).
const CAP_LABELS: Array<[Exclude<keyof ShareCaps, 'internal'>, string]> = [
  ['comments', 'Comments'],
  ['download', 'Download'],
  ['reshare', 'Reshare'],
  ['transcripts', 'Transcript'],
];

declare global { interface Window { __LPOS_SHARE_ORIGIN?: string } }

/** The link clients get: LP Share once it's connected, else LPOS's own staff viewer. */
export function shareUrl(token: string): string {
  return `${window.__LPOS_SHARE_ORIGIN || window.location.origin}/s/${token}`;
}

/** Where "Open" goes: through /share-auth (arrive with a staff pass) once LP Share is connected. */
export function shareOpenHref(token: string): string {
  if (typeof window !== 'undefined' && window.__LPOS_SHARE_ORIGIN) return `/share-auth?next=${encodeURIComponent(`/s/${token}`)}`;
  return `/s/${token}`;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Create a share (ad-hoc from videos, or for a Platform pass) and copy its link. */
export async function createShare(input:
  | { passId: string; name?: string }
  | { items: Array<{ assetId: string; projectId: string }>; name: string },
): Promise<ShareLink> {
  const res = await fetch('/api/share-links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const data = await res.json() as { share?: ShareLink; error?: string };
  if (!res.ok || !data.share) throw new Error(data.error ?? 'Could not create the share');
  await copyText(shareUrl(data.share.token));
  return data.share;
}

interface Props {
  shareId: string;
  /** The project the window was opened from — the Add-videos picker starts there. */
  projectId?: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

/** The project most of the share's videos come from (where Add videos opens by default). */
function mostCommonProject(ids: string[]): string | null {
  const n = new Map<string, number>();
  for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function fmtGB(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

export function ShareModal({ shareId, projectId = null, onClose, onChanged }: Readonly<Props>) {
  const { toast } = useToast();
  const [share, setShare] = useState<ShareLink | null>(null);
  const [view, setView]   = useState<ShareView | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [picking, setPicking] = useState(false);
  const [viewMode, setViewMode] = useViewMode('lpos:share:items-view');

  const load = useCallback(async () => {
    const res = await fetch(`/api/share-links/${shareId}`);
    if (!res.ok) return;
    const data = await res.json() as { share: ShareLink; view: ShareView };
    setShare(data.share);
    setView(data.view);
  }, [shareId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function patch(body: Partial<{ name: string; caps: Partial<ShareCaps>; audience: ShareAudience; emails: string[]; downloadsUntil: string }>) {
    const res = await fetch(`/api/share-links/${shareId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) {
      await load();
      onChanged?.();
    }
  }

  async function copy() {
    if (!share) return;
    const ok = await copyText(shareUrl(share.token));
    toast({ id: `share-copy:${share.id}`, kind: 'publish', tone: ok ? 'success' : 'error', title: ok ? 'Link copied' : 'Copy failed', body: shareUrl(share.token).replace(/^https?:\/\//, '') });
  }

  async function revoke() {
    await fetch(`/api/share-links/${shareId}`, { method: 'DELETE' });
    onChanged?.();
    onClose();
  }

  /** Live picker changes: each tick adds, each untick removes, straight away. */
  async function pickerChange(adds: Array<{ assetId: string; projectId: string }>, removes: string[]) {
    if (adds.length) await fetch(`/api/share-links/${shareId}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: adds }) });
    for (const assetId of removes) {
      await fetch(`/api/share-links/${shareId}/items`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId }) });
    }
    await load();
    onChanged?.();
  }

  /** A typed title overrides the automatic one; clearing it (or the restore link) goes back to automatic. */
  async function setTitle(i: ShareViewItem, value: string) {
    const next = value.trim() && value.trim() !== i.autoTitle ? value.trim() : null;
    if (next === i.clientTitle) return;
    await fetch(`/api/share-links/${shareId}/items`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: i.assetId, projectId: i.projectId, clientTitle: next }) });
    await load();
    onChanged?.();
  }

  async function removeItem(assetId: string) {
    await fetch(`/api/share-links/${shareId}/items`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId }) });
    await load();
    onChanged?.();
  }

  function addEmail() {
    if (!share || !emailDraft.includes('@')) return;
    void patch({ emails: [...share.emails, emailDraft], audience: 'email' });
    setEmailDraft('');
  }

  const items = view?.groups.flatMap((g) => g.items) ?? [];
  // Stable identity per reload, so the picker only resyncs when the share actually changed.
  const existingIds = useMemo(() => new Set(items.map((i) => i.assetId)), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const audience: ShareAudience = share?.caps.internal ? 'staff' : share?.audience ?? 'link';

  const dl = items.map((i) => i.download);
  const dlReady = dl.filter((d) => d?.state === 'ready').length;
  const dlFailed = dl.filter((d) => d?.state === 'failed').length;
  const dlBytes = dl.reduce((n, d) => n + (d?.original?.size ?? 0) + (d?.web?.size ?? 0), 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-box shm-box${picking ? ' shm-box--picking' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share">
        {!share ? (
          <p className="modal-body-text">Loading…</p>
        ) : (
          <>
            <div className="shm-head">
              <input
                key={share.id + share.name}
                className="shm-name"
                defaultValue={share.name}
                aria-label="Share name"
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== share.name) void patch({ name: e.target.value }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <div className="shm-link">
                <span className="shm-url">{shareUrl(share.token).replace(/^https?:\/\//, '')}</span>
                <button type="button" className="shm-icon" onClick={() => void copy()} title="Copy link" aria-label="Copy link">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>
                </button>
                <a className="shm-open" href={shareOpenHref(share.token)} target="_blank" rel="noreferrer">Open</a>
              </div>
            </div>

            {picking ? (
              <AddVideosPicker
                existing={existingIds}
                startProjectId={projectId ?? mostCommonProject(items.map((i) => i.projectId))}
                onChange={pickerChange}
                onClose={() => setPicking(false)}
              />
            ) : (<>
            <div className="shm-section">
              <div className="shm-toggles">
                {CAP_LABELS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="switch"
                    className={`shm-toggle${share.caps[k] ? ' is-on' : ''}`}
                    aria-checked={share.caps[k]}
                    onClick={() => void patch({ caps: { [k]: !share.caps[k] } })}
                  >
                    <span className="shm-switch" aria-hidden="true" />{label}
                  </button>
                ))}
              </div>
              {share.caps.download && (
                <div className="shm-dlline">
                  <span>
                    {dlReady === items.length ? `Downloads ready · ${fmtGB(dlBytes)}` : `Preparing downloads · ${dlReady} of ${items.length} ready`}
                    {dlFailed > 0 && <span className="shm-warn"> · {dlFailed} failed</span>}
                  </span>
                  <span className="shm-sep" aria-hidden="true">·</span>
                  <label className="shm-until">
                    Expires
                    <input
                      type="date"
                      value={share.downloadsUntil ? share.downloadsUntil.slice(0, 10) : ''}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => { if (e.target.value) void patch({ downloadsUntil: new Date(`${e.target.value}T23:59:59`).toISOString() }); }}
                      aria-label="Downloads expire on"
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="shm-section">
              <label className="shm-who">
                <span className="shm-who-label">Who can open it</span>
                <select value={audience} onChange={(e) => void patch({ audience: e.target.value as ShareAudience })} aria-label="Who can open this share">
                  <option value="link">Anyone with the link</option>
                  <option value="email">Specific people</option>
                  <option value="staff">LP Staff Only</option>
                </select>
              </label>
              {audience === 'email' && (
                <div className="shm-emails">
                  {share.emails.map((e) => (
                    <span key={e} className="shm-email">{e}
                      <button type="button" aria-label={`Remove ${e}`} onClick={() => void patch({ emails: share.emails.filter((x) => x !== e) })}>×</button>
                    </span>
                  ))}
                  <input
                    className="shm-email-input" placeholder="Add email" value={emailDraft} aria-label="Add email"
                    onChange={(e) => setEmailDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEmail(); } }}
                    onBlur={addEmail}
                  />
                </div>
              )}
            </div>

            <div className="shm-items-head">
              <span className="shm-count">{items.length} video{items.length === 1 ? '' : 's'}</span>
              <span style={{ flex: 1 }} />
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              <button type="button" className="shm-add" onClick={() => setPicking(true)}>+ Add videos</button>
            </div>
            <div className={viewMode === 'cards' ? 'shm-cards' : 'shm-items'}>
              {items.map((i) => (
                <div key={i.assetId} className={viewMode === 'cards' ? 'shm-card' : 'shm-item'}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={i.thumbnailUrl} alt="" className="shm-thumb" />
                  <span className="shm-item-text">
                    <input
                      key={`${i.assetId}:${i.title}`}
                      className="shm-title-input"
                      defaultValue={i.title}
                      aria-label={`Title for ${i.lposName}`}
                      title="Click to rename"
                      onBlur={(e) => void setTitle(i, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { (e.target as HTMLInputElement).value = i.title; (e.target as HTMLInputElement).blur(); } }}
                    />
                    {i.clientTitle && (
                      <button type="button" className="shm-restore" onClick={() => void setTitle(i, '')} title="Use this name again">{i.autoTitle}</button>
                    )}
                    {share.caps.download && i.download?.state === 'failed' && (
                      <span className="shm-item-warn">Download unavailable - {i.download.error ?? 'file missing'}</span>
                    )}
                  </span>
                  <button type="button" className="shm-remove" aria-label={`Remove ${i.title}`} title="Remove from share" onClick={() => void removeItem(i.assetId)}>×</button>
                </div>
              ))}
            </div>

            <div className="shm-foot">
              {confirmRevoke ? (
                <>
                  <span className="shm-warn">Revoke? The link stops working for everyone.</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="modal-btn-ghost" onClick={() => setConfirmRevoke(false)}>Keep</button>
                  <button type="button" className="modal-btn-danger" onClick={() => void revoke()}>Revoke</button>
                </>
              ) : (
                <>
                  <button type="button" className="shm-revoke" onClick={() => setConfirmRevoke(true)}>Revoke link</button>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="modal-btn-primary" onClick={onClose}>Close</button>
                </>
              )}
            </div>
            </>)}
          </>
        )}
      </div>
    </div>
  );
}
