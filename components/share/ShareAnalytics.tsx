'use client';

/**
 * ShareAnalytics — the Analytics view of the share window: who has opened the
 * share, video-link opens, downloads and client comments. Read live from LP
 * Share (it records the events). Two kinds of viewer, never blended:
 *   Signed in — opened with an email sign-in (Specific-people shares); a person.
 *   Visitor   — anyone else; one per browser, named only if they typed a name.
 * Staff visits and link previews are never counted.
 */

import { useEffect, useState } from 'react';
import type { ShareActivity } from '@/lib/services/share-app';

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const FILE_LABEL: Record<string, string> = { original: 'original', web: 'web copy', srt: 'SRT', vtt: 'VTT', txt: 'transcript' };

function KindBadge({ kind }: { kind: 'email' | 'visitor' }) {
  return <span className={`sha-badge sha-badge--${kind}`}>{kind === 'email' ? 'Signed in' : 'Visitor'}</span>;
}

export function ShareAnalytics({ shareId }: Readonly<{ shareId: string }>) {
  const [data, setData] = useState<ShareActivity | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/share-links/${shareId}/activity`)
      .then(async (r) => {
        const d = await r.json() as { activity?: ShareActivity | null; error?: string };
        if (!alive) return;
        if (!r.ok) setError(d.error ?? 'Could not load analytics');
        else setData(d.activity ?? null);
      })
      .catch(() => { if (alive) setError('Could not load analytics'); });
    return () => { alive = false; };
  }, [shareId]);

  if (error) return <p className="sha-empty">{error}</p>;
  if (data === undefined) return <p className="sha-empty">Loading…</p>;
  if (!data || (!data.totals.firstAt && !data.invited.length && !data.totals.comments)) {
    return (
      <div className="sha">
        <p className="sha-empty">No one has opened this share yet.</p>
        <p className="sha-note">Staff visits and link previews aren’t counted.</p>
      </div>
    );
  }

  const { totals, invited, viewers, videos, recent } = data;
  const invitedSet = new Set(invited.map((i) => i.email));
  // On a Specific-people share the invited list already covers signed-in people.
  const others = viewers.filter((v) => !(v.email && invitedSet.has(v.email)));
  const openedCount = invited.filter((i) => i.opened).length;
  const busyVideos = videos.filter((v) => v.videoLinkOpens || v.downloads || v.comments);

  const tiles: Array<[number, string]> = [
    [totals.visits, totals.visits === 1 ? 'Visit' : 'Visits'],
    [totals.signedIn, 'Signed in'],
    [totals.visitors, totals.visitors === 1 ? 'Visitor' : 'Visitors'],
    [totals.downloads, totals.downloads === 1 ? 'Download' : 'Downloads'],
    [totals.comments, totals.comments === 1 ? 'Comment' : 'Comments'],
  ];
  if (totals.videoLinkOpens) tiles.splice(3, 0, [totals.videoLinkOpens, 'Video-link opens']);

  return (
    <div className="sha">
      <div className="sha-tiles">
        {tiles.map(([n, label]) => (
          <div key={label} className="sha-tile">
            <span className="sha-num">{n}</span>
            <span className="sha-tile-label">{label}</span>
          </div>
        ))}
      </div>
      {totals.firstAt && (
        <p className="sha-line">First opened {ago(totals.firstAt)} · last activity {ago(totals.lastAt)}</p>
      )}

      {invited.length > 0 && (
        <section className="sha-section">
          <h3 className="sha-h">Specific people <span className="sha-h-sub">{openedCount} of {invited.length} opened</span></h3>
          <ul className="sha-list">
            {invited.map((i) => (
              <li key={i.email} className={`sha-row${i.opened ? '' : ' is-quiet'}`}>
                <span className="sha-who">{i.email}</span>
                <span className="sha-meta">{i.opened ? `${plural(i.visits, 'visit')} · last ${ago(i.lastAt)}` : 'Not opened yet'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {others.length > 0 && (
        <section className="sha-section">
          <h3 className="sha-h">{invited.length ? 'Others' : 'Who opened it'}</h3>
          <ul className="sha-list">
            {others.map((v) => (
              <li key={`${v.kind}:${v.label}:${v.firstAt}`} className="sha-row">
                <span className="sha-who"><KindBadge kind={v.kind} />{v.label}</span>
                <span className="sha-meta">
                  {[
                    v.visits ? plural(v.visits, 'visit') : null,
                    v.videoLinkOpens ? plural(v.videoLinkOpens, 'video-link open') : null,
                    v.downloads ? plural(v.downloads, 'download') : null,
                    v.comments ? plural(v.comments, 'comment') : null,
                  ].filter(Boolean).join(' · ')} · last {ago(v.lastAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {busyVideos.length > 0 && (
        <section className="sha-section">
          <h3 className="sha-h">By video</h3>
          <ul className="sha-list">
            {busyVideos.map((v) => (
              <li key={v.assetId} className="sha-row">
                <span className="sha-who">{v.title}</span>
                <span className="sha-meta">
                  {[
                    v.videoLinkOpens ? plural(v.videoLinkOpens, 'link open') : null,
                    v.downloads ? plural(v.downloads, 'download') : null,
                    v.comments ? plural(v.comments, 'comment') : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="sha-section">
          <h3 className="sha-h">Recent</h3>
          <ul className="sha-list sha-list--recent">
            {recent.slice(0, 15).map((e, idx) => (
              <li key={`${e.at}:${idx}`} className="sha-row">
                <span className="sha-who">
                  <KindBadge kind={e.viewerKind} />
                  {e.viewer}{' '}
                  <span className="sha-verb">
                    {e.kind === 'open' ? 'opened the share'
                      : e.kind === 'video_open' ? `opened the link to ${e.assetTitle ?? 'a video'}`
                      : `downloaded ${e.assetTitle ?? 'a video'}${e.fileKind ? ` (${FILE_LABEL[e.fileKind] ?? e.fileKind})` : ''}`}
                  </span>
                </span>
                <span className="sha-meta">{ago(e.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="sha-note">
        Staff visits and link previews aren’t counted. Visits within 30 minutes count once. A visitor is one browser, so the same person on two devices shows twice.
      </p>
    </div>
  );
}
