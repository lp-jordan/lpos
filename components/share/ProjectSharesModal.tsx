'use client';

/**
 * ProjectSharesModal — every share that includes this project's videos
 * (ad-hoc shares and Platform passes alike). Replaces the old Deliverables hub
 * (Frame.io review links + delivery links) in the Media tab.
 */

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import type { ShareSummary } from '@/lib/services/share-links';
import { ShareModal, shareUrl } from './ShareModal';

const CAP_SHORT: Array<[keyof ShareSummary['caps'], string]> = [
  ['comments', 'Comments'], ['versions', 'Versions'], ['download', 'Download'], ['reshare', 'Reshare'], ['transcripts', 'Transcripts'],
];

export function ProjectSharesModal({ projectId, onClose }: Readonly<{ projectId: string; onClose: () => void }>) {
  const { toast } = useToast();
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [managing, setManaging] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/share-links?projectId=${encodeURIComponent(projectId)}`);
    const data = await res.json() as { shares?: ShareSummary[] };
    setShares(data.shares ?? []);
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function copy(s: ShareSummary) {
    try {
      await navigator.clipboard.writeText(shareUrl(s.token));
      toast({ id: `share-copy:${s.id}`, kind: 'publish', tone: 'success', title: 'Link copied', body: s.name });
    } catch { /* ignore */ }
  }

  if (managing) return <ShareModal shareId={managing} onClose={() => { setManaging(null); void load(); }} onChanged={() => void load()} />;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box shl-box" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Shares">
        <div className="modal-header"><h2 className="modal-title">Shares</h2></div>
        {shares === null ? <p className="modal-body-text">Loading…</p>
          : shares.length === 0 ? <p className="modal-body-text">Nothing shared yet. Select videos and choose Share.</p>
          : shares.map((s) => (
            <div key={s.id} className="shl-row" role="button" tabIndex={0}
              onClick={() => setManaging(s.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') setManaging(s.id); }}>
              <span>
                <span className="shl-name">{s.name}</span>
                <span className="shl-meta">
                  {s.videoCount} video{s.videoCount === 1 ? '' : 's'}
                  {s.passTitle && <span className="shl-cap">Pass</span>}
                  {s.caps.internal && <span className="shv-pill shv-pill--internal">LP Staff Only</span>}
                  {s.stage === 'delivered' && <span className="shv-pill">Delivered</span>}
                  {CAP_SHORT.filter(([k]) => s.caps[k]).map(([k, l]) => <span key={k} className="shl-cap">{l}</span>)}
                </span>
              </span>
              <button type="button" className="shm-icon" title="Copy link" aria-label="Copy link"
                onClick={(e) => { e.stopPropagation(); void copy(s); }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>
              </button>
              <a className="shm-open" href={`/s/${s.token}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open</a>
            </div>
          ))}
        <div className="modal-actions"><button type="button" className="modal-btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
