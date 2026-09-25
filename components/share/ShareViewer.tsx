'use client';

/**
 * ShareViewer — the one viewer every share link renders in (/s/:token for a
 * whole share, /v/:videoToken for a single reshared video).
 *
 * The layout is fixed: header · library · player · side panel. A share's
 * switches only add or remove pieces:
 *   comments    → Comments tab (the same AssetComments system as the media page),
 *                 on the newest cut — shares always play each video's newest cut
 *   download    → Download buttons + Download all
 *   reshare     → copy-link icon + right-click "Copy video link"
 *   transcripts → Transcript tab
 *   internal    → staff-only; internal comments visible and new ones stay internal
 *
 * The player is LPOS's MediaPlayer. This in-LPOS version is staff-only; the
 * "client view" toggle previews exactly what a client would see.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { MediaPlayer } from '@/components/media/MediaPlayer';
import { AssetCommentsSection, useAssetComments } from '@/components/media/AssetComments';
import { useContextMenu } from '@/contexts/ContextMenuContext';
import { useToast } from '@/contexts/ToastContext';
import type { ShareView, ShareViewItem } from '@/lib/services/share-links';

type Source = { kind: 'share' | 'video'; token: string };

interface TranscriptCue { fromMs: number; text: string }

function fmtDuration(s: number | null): string {
  if (!s || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

const IconLink = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/>
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/>
  </svg>
);
const IconDownload = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>
  </svg>
);
const IconHome = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>
  </svg>
);
const IconEye = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);

export function ShareViewer({ source }: Readonly<{ source: Source }>) {
  const [view, setView]       = useState<ShareView | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [clientView, setClientView] = useState(false);
  const [sideTab, setSideTab] = useState<'comments' | 'transcript'>('comments');
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const timeRef = useRef(0);
  const { openMenu } = useContextMenu();
  const { toast } = useToast();

  const load = useCallback(async () => {
    const url = source.kind === 'share' ? `/api/share-links/view/${source.token}` : `/api/share-links/video/${source.token}`;
    try {
      const res = await fetch(url);
      const data = await res.json() as ShareView & { error?: string };
      if (!res.ok) { setError(data.error ?? 'This link is no longer available.'); return; }
      setView(data);
    } catch {
      setError('Could not load this share.');
    }
  }, [source.kind, source.token]);

  useEffect(() => { void load(); }, [load]);

  const items = useMemo(() => view?.groups.flatMap((g) => g.items) ?? [], [view]);
  const item: ShareViewItem | null = items.find((i) => i.assetId === assetId) ?? items[0] ?? null;
  const caps = view?.share.caps;

  // Staff see internal threads unless previewing as a client; an Internal share
  // shows them to everyone (only staff can open it) and posts new ones internal.
  const ac = useAssetComments({
    projectId:       item?.projectId ?? '',
    assetId:         item?.assetId ?? null,
    frameioAssetId:  null,
    audience:        caps?.internal || !clientView ? 'all' : 'client',
    postVisibility:  caps?.internal ? 'internal' : null,
  });

  const commentsOn    = !!caps?.comments;
  const transcriptsOn = !!caps?.transcripts;
  const activeTab: 'comments' | 'transcript' | null =
    sideTab === 'comments' && commentsOn ? 'comments'
      : sideTab === 'transcript' && transcriptsOn ? 'transcript'
      : commentsOn ? 'comments' : transcriptsOn ? 'transcript' : null;

  const src = !item ? ''
    : item.stream === 'local' ? `/api/projects/${item.projectId}/media/${item.assetId}/stream`
    : `/api/projects/${item.projectId}/media/${item.assetId}/frameio-stream`;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ id: `share-copy:${text}`, kind: 'publish', tone: 'success', title: label, body: text.replace(/^https?:\/\//, '') });
    } catch {
      toast({ id: `share-copy-err:${text}`, kind: 'publish', tone: 'error', title: 'Copy failed', body: text });
    }
  }
  const videoUrl = (i: ShareViewItem) => `${origin}/v/${i.videoToken}`;
  const shareUrl = view ? `${origin}/s/${view.share.token}` : '';
  const downloadUrl = (i: ShareViewItem) => `/api/projects/${i.projectId}/media/${i.assetId}/download`;

  function download(i: ShareViewItem) {
    const a = document.createElement('a');
    a.href = downloadUrl(i);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function downloadAll() {
    items.filter((i) => i.downloadable).forEach((i, n) => setTimeout(() => download(i), n * 400));
  }

  function onVideoContext(e: React.MouseEvent, i: ShareViewItem) {
    if (!caps) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      ...(caps.reshare ? [{ type: 'item' as const, label: 'Copy video link', onClick: () => void copy(videoUrl(i), 'Video link copied') }] : []),
      ...(source.kind === 'share' ? [{ type: 'item' as const, label: 'Copy share link', onClick: () => void copy(shareUrl, 'Share link copied') }] : []),
      ...(caps.download && i.downloadable ? [{ type: 'item' as const, label: 'Download', onClick: () => download(i) }] : []),
    ]);
  }

  if (error) {
    return (
      <div className="shv-root">
        <Header name={null} internal={false} right={null} />
        <div className="shv-empty">{error}</div>
      </div>
    );
  }
  if (!view || !caps) return <div className="shv-root"><Header name={null} internal={false} right={null} /></div>;

  const showLib = items.length > 1;
  const cols = ['shv-body', showLib ? '' : 'shv-body--nolib', activeTab ? '' : 'shv-body--noside'].filter(Boolean).join(' ');

  return (
    <div className="shv-root">
      <Header
        name={view.share.name}
        internal={caps.internal}
        right={(
          <>
            {caps.download && items.some((i) => i.downloadable) && (
              <button type="button" className="shv-btn shv-btn--gold" onClick={downloadAll}><IconDownload /> Download all</button>
            )}
            {!caps.internal && (
              <button
                type="button"
                className={`shv-icon-btn${clientView ? ' is-on' : ''}`}
                onClick={() => setClientView((v) => !v)}
                title={clientView ? 'Previewing as a client — click for staff view' : 'Preview as a client'}
                aria-pressed={clientView}
              ><IconEye /></button>
            )}
          </>
        )}
      />

      <div className={cols}>
        {showLib && (
          <nav className="shv-lib" aria-label="Videos">
            {view.groups.map((g, gi) => (
              <div key={g.title ?? `g${gi}`} className="shv-group">
                {g.title && <div className="shv-cat">{g.title}</div>}
                {g.items.map((i) => (
                  <div key={i.assetId} className="shv-row-wrap" onContextMenu={(e) => onVideoContext(e, i)}>
                    <button
                      type="button"
                      className={`shv-row${i.assetId === item?.assetId ? ' is-sel' : ''}`}
                      onClick={() => { setAssetId(i.assetId); setSeekTarget(null); }}
                    >
                      <img className="shv-thumb" src={i.thumbnailUrl} alt="" loading="lazy" />
                      <span className="shv-row-text">
                        <span className="shv-row-title">{i.title}</span>
                        <span className="shv-row-meta">
                          {fmtDuration(i.duration)}
                        </span>
                      </span>
                    </button>
                    {caps.reshare && (
                      <button type="button" className="shv-icon-btn shv-row-copy" onClick={() => void copy(videoUrl(i), 'Video link copied')} title="Copy video link" aria-label="Copy video link">
                        <IconLink />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </nav>
        )}

        <main className="shv-main">
          {item && (
            <>
              <div className="shv-player" onContextMenu={(e) => onVideoContext(e, item)}>
                {item.stream ? (
                  <MediaPlayer
                    key={item.assetId}
                    variant="compact"
                    src={src}
                    assetId={item.assetId}
                    projectId={item.projectId}
                    frameioAssetId={null}
                    comments={commentsOn ? ac.comments : []}
                    seekTarget={seekTarget}
                    onSeekHandled={() => setSeekTarget(null)}
                    onCurrentTimeChange={(t) => { timeRef.current = t; }}
                  />
                ) : (
                  <div className="shv-empty">This video isn’t available to play yet.</div>
                )}
              </div>
              <div className="shv-under">
                <h1 className="shv-title">{item.title}</h1>
                <span className="shv-grow" />
                {caps.reshare && (
                  <button type="button" className="shv-icon-btn" onClick={() => void copy(videoUrl(item), 'Video link copied')} title="Copy video link" aria-label="Copy video link"><IconLink /></button>
                )}
                {caps.download && item.downloadable && (
                  <button type="button" className="shv-icon-btn" onClick={() => download(item)} title="Download" aria-label="Download"><IconDownload /></button>
                )}
              </div>
              {!clientView && item.title !== item.lposName && <div className="shv-staff-note">{item.lposName}</div>}
            </>
          )}
        </main>

        {activeTab && item && (
          <aside className="shv-side">
            {commentsOn && transcriptsOn && (
              <div className="shv-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={activeTab === 'comments'} className={activeTab === 'comments' ? 'is-on' : ''} onClick={() => setSideTab('comments')}>Comments</button>
                <button type="button" role="tab" aria-selected={activeTab === 'transcript'} className={activeTab === 'transcript' ? 'is-on' : ''} onClick={() => setSideTab('transcript')}>Transcript</button>
              </div>
            )}
            <div className="shv-side-body">
              {activeTab === 'comments' ? (
                <AssetCommentsSection
                  ac={ac}
                  onSeek={(t) => setSeekTarget(t)}
                  getCurrentTime={() => timeRef.current}
                  canModerate={!clientView}
                  showVersionSelect={false}
                  showInternalTag={!clientView}
                  composePlaceholder={caps.internal ? 'Add an internal comment…' : 'Add a comment…'}
                />
              ) : (
                <Transcript item={item} onSeek={(t) => setSeekTarget(t)} />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Header({ name, internal, right }: Readonly<{ name: string | null; internal: boolean; right: React.ReactNode }>) {
  return (
    <header className="shv-head">
      <div className="shv-head-left">
        <span className="shv-home-slot">
          <Link href="/s" className="shv-icon-btn shv-homebtn" title="All shares" aria-label="All shares"><IconHome /></Link>
        </span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="shv-logo" src="/share/leaderpass-logo.png" alt="LeaderPass" />
      </div>
      <div className="shv-head-center">
        {name && <span className="shv-name">{name}</span>}
        {internal && <span className="shv-pill shv-pill--internal">LP Staff Only</span>}
      </div>
      <div className="shv-head-right">{right}</div>
    </header>
  );
}

function Transcript({ item, onSeek }: Readonly<{ item: ShareViewItem; onSeek: (t: number) => void }>) {
  const [cues, setCues] = useState<TranscriptCue[] | null>(null);
  useEffect(() => {
    let live = true;
    setCues(null);
    fetch(`/api/projects/${item.projectId}/media/${item.assetId}/transcript`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { en?: { cues: TranscriptCue[] } | null } | null) => { if (live) setCues(d?.en?.cues ?? []); })
      .catch(() => { if (live) setCues([]); });
    return () => { live = false; };
  }, [item.projectId, item.assetId]);

  if (cues === null) return <p className="mad-comments-empty">Loading…</p>;
  if (!cues.length) return <p className="mad-comments-empty">No transcript yet.</p>;
  return (
    <div className="shv-transcript">
      {cues.map((c) => (
        <button key={c.fromMs} type="button" className="shv-cue" onClick={() => onSeek(c.fromMs / 1000)}>
          <span className="shv-cue-tc">{fmtDuration(Math.floor(c.fromMs / 1000)) || '0:00'}</span>
          <span>{c.text}</span>
        </button>
      ))}
    </div>
  );
}
