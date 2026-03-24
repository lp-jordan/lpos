'use client';

import { MediaAsset, AssetStatus } from '@/lib/demo-data/media-projects';

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  approved: 'Approved',
  published: 'Published',
};

const NEXT_STATUS: Record<AssetStatus, AssetStatus | null> = {
  draft: 'in_review',
  in_review: 'approved',
  approved: 'published',
  published: null,
};

interface Props {
  asset: MediaAsset;
  onSelect: (asset: MediaAsset) => void;
  onStatusAdvance: (assetId: string, newStatus: AssetStatus) => void;
}

export function MediaAssetCard({ asset, onSelect, onStatusAdvance }: Readonly<Props>) {
  const next = NEXT_STATUS[asset.status];

  return (
    <div className="m-asset-card">
      {/* Thumbnail placeholder */}
      <button className="m-asset-thumb" type="button" onClick={() => onSelect(asset)}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" opacity="0.35">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
        <span className="m-asset-duration">{asset.duration}</span>
      </button>

      {/* Info */}
      <div className="m-asset-info">
        <button className="m-asset-title" type="button" onClick={() => onSelect(asset)}>
          {asset.title}
        </button>
        <div className="m-asset-meta">
          <span>R{asset.round}</span>
          <span>{asset.uploadDate}</span>
          <span>{asset.uploader}</span>
        </div>
      </div>

      {/* Status badge — clickable to advance */}
      <button
        className={`m-status-badge m-status-badge--${asset.status}${next ? ' m-status-badge--clickable' : ''}`}
        type="button"
        onClick={(e) => { e.stopPropagation(); if (next) onStatusAdvance(asset.assetId, next); }}
        title={next ? `Advance to ${STATUS_LABELS[next]}` : 'Final status'}
      >
        {STATUS_LABELS[asset.status]}
      </button>

      {/* Hover actions */}
      <div className="m-asset-hover-actions">
        <button type="button" className="m-hover-btn" onClick={() => {}}>Replace</button>
        <button type="button" className="m-hover-btn" onClick={() => {}}>Copy URL</button>
        <button type="button" className="m-hover-btn" onClick={() => onSelect(asset)}>Open</button>
      </div>
    </div>
  );
}
