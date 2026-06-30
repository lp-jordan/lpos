'use client';

/**
 * Internal Review page view.
 *
 * The media page, scoped to one bundle and re-skinned near-black/gold. A list of
 * the bundled clips on the left; clicking one opens the normal MediaDetailPanel
 * (player + comments). Comments are the asset's normal media_comments thread, so
 * feedback flows both ways with the regular media page. See
 * docs/internal-review-spec.md.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';
import type { InternalReview } from '@/lib/models/internal-review';
import { MediaDetailPanel } from '@/components/media/MediaDetailPanel';

interface LoadedState {
  review: InternalReview;
  assets: MediaAsset[];
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const IconFileVideo = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <polygon points="10 11 16 14 10 17 10 11"/>
  </svg>
);

function ClipRow({
  projectId,
  asset,
  isOpen,
  onClick,
}: {
  projectId: string;
  asset: MediaAsset;
  isOpen: boolean;
  onClick: () => void;
}) {
  const [thumbError, setThumbError] = useState(false);
  return (
    <button
      type="button"
      className={`ir-clip${isOpen ? ' ir-clip--open' : ''}`}
      onClick={onClick}
    >
      <span className="ir-clip-thumb">
        {!thumbError ? (
          <img
            src={`/api/projects/${projectId}/media/${asset.assetId}/thumbnail`}
            alt=""
            onError={() => setThumbError(true)}
          />
        ) : (
          <IconFileVideo />
        )}
      </span>
      <span className="ir-clip-main">
        <span className="ir-clip-name">{asset.name}</span>
        <span className="ir-clip-meta">{formatDuration(asset.duration)}</span>
      </span>
    </button>
  );
}

export function InternalReviewView({ reviewId }: { reviewId: string }) {
  const [data, setData] = useState<LoadedState | null>(null);
  const [revoked, setRevoked] = useState<{ name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/internal-reviews/${reviewId}`);
      if (res.status === 410) {
        const d = await res.json() as { name?: string };
        setRevoked({ name: d.name ?? 'This review' });
        return;
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setError(d.error ?? 'Could not load this internal review.');
        return;
      }
      const d = await res.json() as LoadedState;
      setData(d);
      // Keep selection in sync across reloads (comment counts etc.).
      setSelectedAsset((prev) =>
        prev ? (d.assets.find((a) => a.assetId === prev.assetId) ?? prev) : null,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [reviewId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="internal-review-page"><p className="ir-state">Loading…</p></div>;
  }

  if (revoked) {
    return (
      <div className="internal-review-page">
        <div className="ir-expired">
          <h1 className="ir-expired-title">This internal review link has expired</h1>
          <p className="ir-expired-body">
            "{revoked.name}" is no longer available. Ask whoever shared it to send a new link.
          </p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="internal-review-page">
        <p className="ir-state ir-state--error">{error ?? 'Internal review not found.'}</p>
      </div>
    );
  }

  return (
    <div className="internal-review-page">
      <header className="ir-header">
        <span className="ir-header-badge">Internal Review</span>
        <h1 className="ir-header-title">{data.review.name}</h1>
        <span className="ir-header-count">
          {data.assets.length} clip{data.assets.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="ir-body">
        {data.assets.length === 0 ? (
          <p className="ir-state">This review has no clips.</p>
        ) : (
          <div className="ir-clip-list">
            {data.assets.map((a) => (
              <ClipRow
                key={a.assetId}
                projectId={data.review.projectId}
                asset={a}
                isOpen={selectedAsset?.assetId === a.assetId}
                onClick={() => setSelectedAsset(a)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Reused media viewer — player + the asset's normal comment thread. */}
      <MediaDetailPanel
        asset={selectedAsset}
        projectId={data.review.projectId}
        onClose={() => setSelectedAsset(null)}
        onUpdated={() => { void load(); }}
      />
    </div>
  );
}
