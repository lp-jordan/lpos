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

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { ShareCaps, ShareLink, ShareAudience } from '@/lib/store/share-links-db';
import type { ShareView, ShareViewItem } from '@/lib/services/share-links';
import { AddVideosPicker } from './AddVideosPicker';

// Internal isn't a switch here: choosing "LP Staff Only" under Who is what
// makes a share internal (the store keeps caps.internal in step with it).
const CAP_LABELS: Array<[Exclude<keyof ShareCaps, 'internal'>, string]> = [
  ['comments', 'Comments'],
  ['download', 'Download'],
  ['reshare', 'Reshare'],
  ['transcripts', 'Transcript'],
];

export function shareUrl(token: string): string {
  return `${window.location.origin}/s/${token}`;
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
  onClose: () => void;
  onChanged?: () => void;
}

export function ShareModal({ shareId, onClose, onChanged }: Readonly<Props>) {
  const { toast } = useToast();
  const [share, setShare] = useState<ShareLink | null>(null);
  const [view, setView]   = useState<ShareView | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [picking, setPicking] = useState(false);

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

  async function patch(body: Partial<{ name: string; caps: Partial<ShareCaps>; audience: ShareAudience; emails: string[] }>) {
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

  async function addItems(list: Array<{ assetId: string; projectId: string }>) {
    await fetch(`/api/share-links/${shareId}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: list }) });
    setPicking(false);
    await load();
    onChanged?.();
  }

  /** A typed title overrides the automatic one; clearing it goes back to automatic. */
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
  const audience: ShareAudience = share?.caps.internal ? 'staff' : share?.audience ?? 'link';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box shm-box" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share">
        {!share ? (
          <p className="modal-body-text">Loading…</p>
        ) : (
          <>
            <input
              key={share.id + share.name}
              className="modal-input shm-name"
              defaultValue={share.name}
              aria-label="Share name"
              onBlur={(e) => { if (e.target.value.trim() && e.target.value !== share.name) void patch({ name: e.target.value }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />

            <div className="shm-link">
              <span className="shm-url">{shareUrl(share.token).replace(/^https?:\/\//, '')}</span>
              <button type="button" className="shm-icon" onClick={() => void copy()} title="Copy link" aria-label="Copy link">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>
              </button>
              <a className="shm-open" href={`/s/${share.token}`} target="_blank" rel="noreferrer">Open</a>
            </div>

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

            <div className="shm-label">Who</div>
            <div className="shm-seg" role="radiogroup" aria-label="Who can open this share">
              {([['link', 'Anyone with the link'], ['email', 'Specific people'], ['staff', 'LP Staff Only']] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={audience === k}
                  className={audience === k ? 'is-on' : ''} onClick={() => void patch({ audience: k })}>{label}</button>
              ))}
            </div>
            {audience === 'email' && (
              <div className="shm-emails">
                {share.emails.map((e) => (
                  <span key={e} className="shm-email">{e}
                    <button type="button" aria-label={`Remove ${e}`} onClick={() => void patch({ emails: share.emails.filter((x) => x !== e) })}>×</button>
                  </span>
                ))}
                <input
                  className="shm-email-input" placeholder="name@company.com" value={emailDraft} aria-label="Add email"
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEmail(); } }}
                  onBlur={addEmail}
                />
              </div>
            )}

            <div className="shm-items-head">
              <span className="shm-label">{items.length} video{items.length === 1 ? '' : 's'}</span>
              <button type="button" className="shm-add" onClick={() => setPicking((v) => !v)}>{picking ? 'Close' : '+ Add videos'}</button>
            </div>
            {picking ? (
              <AddVideosPicker existing={new Set(items.map((i) => i.assetId))} onAdd={addItems} onClose={() => setPicking(false)} />
            ) : (
              <div className="shm-items">
                {items.map((i) => (
                  <div key={i.assetId} className="shm-item">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={i.thumbnailUrl} alt="" className="shm-thumb" />
                    <span className="shm-item-text">
                      <input
                        key={`${i.assetId}:${i.title}`}
                        className="shm-title-input"
                        defaultValue={i.clientTitle ?? ''}
                        placeholder={i.autoTitle}
                        aria-label={`Title for ${i.lposName}`}
                        onBlur={(e) => void setTitle(i, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      />
                      <span className="shm-item-sub">
                        {i.titleSource === 'manual' ? (
                          <>Custom title · <button type="button" className="shm-reset" onClick={() => void setTitle(i, '')}>use {i.autoTitle === i.lposName ? 'file name' : 'Platform title'}</button></>
                        ) : i.titleSource === 'platform' ? 'Platform title' : 'File name'}
                        {i.lposName !== i.title && <> · {i.lposName}</>}
                      </span>
                    </span>
                    <button type="button" className="shm-mini shm-mini--ghost" aria-label={`Remove ${i.title}`} onClick={() => void removeItem(i.assetId)}>×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions shm-actions">
              {confirmRevoke ? (
                <>
                  <span className="shm-warn">Revoke? The link stops working for everyone.</span>
                  <button type="button" className="modal-btn-ghost" onClick={() => setConfirmRevoke(false)}>Keep</button>
                  <button type="button" className="modal-btn-danger" onClick={() => void revoke()}>Revoke</button>
                </>
              ) : (
                <>
                  <button type="button" className="modal-btn-ghost" onClick={() => setConfirmRevoke(true)}>Revoke</button>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="modal-btn-primary" onClick={onClose}>Close</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
