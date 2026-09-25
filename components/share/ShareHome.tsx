'use client';

/**
 * ShareHome — "Shared with you". In this staff-only LPOS version it lists every
 * live share; the public app will list the shares addressed to the signed-in email.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ShareSummary } from '@/lib/services/share-links';

export function ShareHome() {
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  useEffect(() => {
    fetch('/api/share-links').then((r) => r.json()).then((d: { shares?: ShareSummary[] }) => setShares(d.shares ?? [])).catch(() => setShares([]));
  }, []);

  return (
    <div className="shv-root">
      <header className="shv-head">
        <div className="shv-head-left">
          <span className="shv-home-slot" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="shv-logo" src="/share/leaderpass-logo.png" alt="LeaderPass" />
        </div>
        <div className="shv-head-center" />
        <div className="shv-head-right" />
      </header>
      <div className="shv-home">
        <h1 className="shv-home-title">Shared with you</h1>
        {shares === null ? null : shares.length === 0 ? (
          <p className="shv-empty">Nothing shared yet.</p>
        ) : (
          <div className="shv-cards">
            {shares.map((s) => (
              <Link key={s.id} href={`/s/${s.token}`} className="shv-card">
                <span className="shv-card-name">{s.name}</span>
                <span className="shv-row-meta">
                  {s.videoCount} video{s.videoCount === 1 ? '' : 's'}
                  {s.caps.internal && <span className="shv-pill shv-pill--internal">LP Staff Only</span>}
                  {s.stage === 'delivered' && <span className="shv-pill">Delivered</span>}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
