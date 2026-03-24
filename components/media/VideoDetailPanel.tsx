'use client';

import { VideoAsset } from '@/lib/demo-data/media-folders';

interface Props {
  video: VideoAsset | null;
  onClose: () => void;
}

export function VideoDetailPanel({ video, onClose }: Readonly<Props>) {
  return (
    <div className={`dam-detail-overlay${video ? ' dam-detail-overlay--open' : ''}`}>
      <div className={`dam-detail-panel${video ? ' dam-detail-panel--open' : ''}`}>
        {video && (
          <>
            <div className="dam-detail-header">
              <div>
                <p className="eyebrow">Video Detail</p>
                <h2 className="dam-detail-title">{video.title}</h2>
              </div>
              <button className="dam-detail-close" onClick={onClose} type="button" aria-label="Close panel">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="dam-detail-preview">
              <div className="dam-detail-player">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.5">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span className="dam-detail-player-label">Preview</span>
              </div>
            </div>

            <div className="dam-detail-meta-grid">
              <div className="dam-detail-meta-item">
                <span className="dam-detail-meta-label">Duration</span>
                <span className="dam-detail-meta-value">{video.duration}</span>
              </div>
              <div className="dam-detail-meta-item">
                <span className="dam-detail-meta-label">Resolution</span>
                <span className="dam-detail-meta-value">{video.resolution}</span>
              </div>
              <div className="dam-detail-meta-item">
                <span className="dam-detail-meta-label">File Size</span>
                <span className="dam-detail-meta-value">{video.fileSize}</span>
              </div>
              <div className="dam-detail-meta-item">
                <span className="dam-detail-meta-label">Views</span>
                <span className="dam-detail-meta-value">{video.views.toLocaleString()}</span>
              </div>
              <div className="dam-detail-meta-item">
                <span className="dam-detail-meta-label">Status</span>
                <span className={`dam-status dam-status--${video.status}`}>{video.status}</span>
              </div>
              <div className="dam-detail-meta-item">
                <span className="dam-detail-meta-label">Uploaded</span>
                <span className="dam-detail-meta-value">{video.uploadedAt}</span>
              </div>
            </div>

            <div className="dam-detail-section">
              <h3 className="dam-detail-section-title">Description</h3>
              <p className="dam-detail-description">{video.description}</p>
            </div>

            <div className="dam-detail-section">
              <h3 className="dam-detail-section-title">Tags</h3>
              <div className="dam-detail-tags">
                {video.tags.map((tag) => (
                  <span key={tag} className="dam-tag">{tag}</span>
                ))}
              </div>
            </div>

            <div className="dam-detail-section">
              <h3 className="dam-detail-section-title">File</h3>
              <p className="dam-detail-filename">{video.filename}</p>
            </div>

            <div className="dam-detail-actions">
              <button className="btn" type="button">Copy Link</button>
              <button className="btn-secondary" type="button">Download</button>
              <button className="btn-secondary" type="button">Replace</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
