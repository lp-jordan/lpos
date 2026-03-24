'use client';

import { VideoAsset } from '@/lib/demo-data/media-folders';

interface Props {
  video: VideoAsset;
  onSelect: (video: VideoAsset) => void;
  isSelected: boolean;
}

export function VideoAssetRow({ video, onSelect, isSelected }: Readonly<Props>) {
  const statusClass =
    video.status === 'published' ? 'dam-status--published' :
    video.status === 'ready' ? 'dam-status--ready' :
    'dam-status--processing';

  return (
    <button
      className={`dam-video-row${isSelected ? ' dam-video-row--selected' : ''}`}
      onClick={() => onSelect(video)}
      type="button"
    >
      <div className="dam-video-thumb">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" opacity="0.4">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      </div>
      <div className="dam-video-info">
        <strong className="dam-video-title">{video.title}</strong>
        <span className="dam-video-meta">{video.filename} &middot; {video.resolution} &middot; {video.fileSize}</span>
      </div>
      <span className="dam-video-duration">{video.duration}</span>
      <span className={`dam-status ${statusClass}`}>{video.status}</span>
    </button>
  );
}
