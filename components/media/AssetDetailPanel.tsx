'use client';

import { useState } from 'react';
import { MediaAsset, AssetStatus, FrameIoComment } from '@/lib/demo-data/media-projects';

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  approved: 'Approved',
  published: 'Published',
};

const STATUS_ORDER: AssetStatus[] = ['draft', 'in_review', 'approved', 'published'];

interface Props {
  asset: MediaAsset | null;
  onClose: () => void;
}

export function AssetDetailPanel({ asset, onClose }: Readonly<Props>) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [comments, setComments] = useState<FrameIoComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [activeTimecode, setActiveTimecode] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Sync state when selected asset changes
  const isOpen = asset !== null;
  if (asset && title === '' && comments.length === 0 && (asset.comments?.length ?? 0) > 0) {
    setTitle(asset.title);
    setDescription(asset.description);
    setComments(asset.comments ?? []);
  }
  if (asset && title === '' && (asset.comments?.length ?? 0) === 0) {
    setTitle(asset.title);
    setDescription(asset.description);
  }

  function handleClose() {
    setTitle('');
    setDescription('');
    setComments([]);
    setNewComment('');
    setActiveTimecode(null);
    setIsPlaying(false);
    onClose();
  }

  function handleCopy(text: string, key: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  function handleAddComment() {
    if (!newComment.trim()) return;
    const c: FrameIoComment = {
      id: `c-${Date.now()}`,
      author: 'You',
      authorInitial: 'Y',
      timecode: activeTimecode ?? '0:00',
      text: newComment.trim(),
      resolved: false,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    setComments((prev) => [...prev, c]);
    setNewComment('');
  }

  function handleToggleResolve(id: string) {
    setComments((prev) => prev.map((c) => c.id === id ? { ...c, resolved: !c.resolved } : c));
  }

  const openComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);

  // Compute scrubber markers as % positions
  function timecodeToPercent(tc: string, duration: string): number {
    const toSecs = (t: string) => t.split(':').reduce((acc, v, i, arr) =>
      acc + parseFloat(v) * Math.pow(60, arr.length - 1 - i), 0);
    const total = toSecs(duration);
    if (!total) return 0;
    return Math.min(100, (toSecs(tc) / total) * 100);
  }

  return (
    <>
      {/* Overlay */}
      <div
        className={`m-detail-overlay${isOpen ? ' m-detail-overlay--open' : ''}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside className={`m-detail-panel${isOpen ? ' m-detail-panel--open' : ''}`} aria-label="Asset detail">
        {asset && (
          <div className="m-detail-layout">

            {/* ── Left column: player + comments ── */}
            <div className="m-detail-left">

              {/* Header */}
              <div className="m-detail-header">
                <div className="m-detail-header-title">
                  <span className="eyebrow">{asset.uploader} · {asset.uploadDate}</span>
                </div>
                <button className="m-detail-close" type="button" onClick={handleClose} aria-label="Close panel">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/*
               * ── Frame.io Player ──
               * Production: replace this entire block with the Frame.io SDK player
               * or an <iframe> pointing at asset.frameIoReviewLink.
               *
               * Example (SDK):
               *   import { Player } from '@frame-io/player';
               *   <Player assetId={asset.frameIoAssetId} onTimecodeChange={setActiveTimecode} />
               *
               * Example (iframe):
               *   <iframe
               *     src={`https://app.frame.io/reviews/${asset.frameIoReviewLink}`}
               *     allow="autoplay; fullscreen"
               *     className="m-fio-iframe"
               *   />
               */}
              <div className="m-fio-player">
                <div className="m-fio-player-screen">
                  <button
                    type="button"
                    className={`m-fio-play-btn${isPlaying ? ' playing' : ''}`}
                    onClick={() => setIsPlaying((p) => !p)}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying
                      ? <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                      : <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    }
                  </button>
                  <span className="m-fio-badge">
                    {asset.frameIoAssetId ? 'Frame.io' : 'No player linked'}
                  </span>
                </div>

                {/* Scrubber with comment markers */}
                <div className="m-fio-scrubber-wrap">
                  <span className="m-fio-time">0:00</span>
                  <div className="m-fio-scrubber">
                    <div className="m-fio-scrubber-track" />
                    {comments.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`m-fio-marker${c.resolved ? ' resolved' : ''}`}
                        style={{ left: `${timecodeToPercent(c.timecode, asset.duration)}%` }}
                        onClick={() => setActiveTimecode(c.timecode)}
                        title={`${c.timecode} — ${c.author}: ${c.text}`}
                      />
                    ))}
                  </div>
                  <span className="m-fio-time">{asset.duration}</span>
                </div>
              </div>

              {/* Comments */}
              <div className="m-fio-comments">
                <div className="m-fio-comments-header">
                  <span className="m-fio-comments-label">
                    Comments
                    {openComments.length > 0 && (
                      <span className="m-fio-comments-count">{openComments.length}</span>
                    )}
                  </span>
                </div>

                <div className="m-fio-comment-list">
                  {comments.length === 0 && (
                    <p className="m-fio-empty">No comments yet. Add one below.</p>
                  )}
                  {openComments.map((c) => (
                    <div key={c.id} className="m-fio-comment">
                      <div className="m-fio-comment-avatar">{c.authorInitial}</div>
                      <div className="m-fio-comment-body">
                        <div className="m-fio-comment-meta">
                          <span className="m-fio-comment-author">{c.author}</span>
                          <button
                            type="button"
                            className="m-fio-timecode-btn"
                            onClick={() => setActiveTimecode(c.timecode)}
                          >
                            {c.timecode}
                          </button>
                        </div>
                        <p className="m-fio-comment-text">{c.text}</p>
                      </div>
                      <button
                        type="button"
                        className="m-fio-resolve-btn"
                        onClick={() => handleToggleResolve(c.id)}
                        title="Mark resolved"
                        aria-label="Resolve comment"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </button>
                    </div>
                  ))}

                  {resolvedComments.length > 0 && (
                    <details className="m-fio-resolved-group">
                      <summary className="m-fio-resolved-toggle">
                        {resolvedComments.length} resolved
                      </summary>
                      {resolvedComments.map((c) => (
                        <div key={c.id} className="m-fio-comment m-fio-comment--resolved">
                          <div className="m-fio-comment-avatar resolved">{c.authorInitial}</div>
                          <div className="m-fio-comment-body">
                            <div className="m-fio-comment-meta">
                              <span className="m-fio-comment-author">{c.author}</span>
                              <button type="button" className="m-fio-timecode-btn">{c.timecode}</button>
                            </div>
                            <p className="m-fio-comment-text">{c.text}</p>
                          </div>
                          <button
                            type="button"
                            className="m-fio-resolve-btn resolved"
                            onClick={() => handleToggleResolve(c.id)}
                            title="Reopen comment"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </details>
                  )}
                </div>

                {/* Add comment */}
                <div className="m-fio-add-comment">
                  {activeTimecode && (
                    <div className="m-fio-active-tc">
                      <span>at {activeTimecode}</span>
                      <button type="button" onClick={() => setActiveTimecode(null)}>✕</button>
                    </div>
                  )}
                  <div className="m-fio-add-comment-row">
                    <input
                      className="m-fio-comment-input"
                      type="text"
                      placeholder="Add a comment..."
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddComment(); }}
                    />
                    <button
                      type="button"
                      className="m-fio-submit-btn"
                      onClick={handleAddComment}
                      disabled={!newComment.trim()}
                    >
                      Post
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Right column: metadata ── */}
            <div className="m-detail-right">

              {/* Title */}
              <div className="m-detail-field">
                <label className="m-detail-field-label">Title</label>
                <input
                  className="m-detail-field-input"
                  value={title || asset.title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              {/* Description */}
              <div className="m-detail-field">
                <label className="m-detail-field-label">Description</label>
                <textarea
                  className="m-detail-field-textarea"
                  value={description || asset.description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>

              {/* Meta grid */}
              <div className="m-detail-meta-grid">
                <div className="m-detail-meta-item">
                  <span className="m-detail-meta-label">Status</span>
                  <select
                    className={`m-status-select m-status-select--${asset.status}`}
                    value={asset.status}
                    onChange={() => {}}
                  >
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div className="m-detail-meta-item">
                  <span className="m-detail-meta-label">Round</span>
                  <span className="m-detail-meta-value">R{asset.round}</span>
                </div>
                <div className="m-detail-meta-item">
                  <span className="m-detail-meta-label">Duration</span>
                  <span className="m-detail-meta-value">{asset.duration}</span>
                </div>
                <div className="m-detail-meta-item">
                  <span className="m-detail-meta-label">Uploaded by</span>
                  <span className="m-detail-meta-value">{asset.uploader}</span>
                </div>
              </div>

              {/* URLs */}
              <div className="m-detail-field">
                <label className="m-detail-field-label">Stream URL</label>
                <div className="m-detail-copyable">
                  <span className="m-detail-copyable-text">{asset.streamUrl}</span>
                  <button type="button" className="m-copy-btn" onClick={() => handleCopy(asset.streamUrl, 'stream')}>
                    {copied === 'stream' ? '✓' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="m-detail-field">
                <label className="m-detail-field-label">Embed Code</label>
                <div className="m-detail-copyable">
                  <span className="m-detail-copyable-text">{asset.embedUrl}</span>
                  <button type="button" className="m-copy-btn" onClick={() => handleCopy(asset.embedUrl, 'embed')}>
                    {copied === 'embed' ? '✓' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Frame.io link */}
              {asset.frameIoReviewLink && (
                <div className="m-detail-field">
                  <label className="m-detail-field-label">Review Link</label>
                  <div className="m-detail-copyable">
                    <span className="m-detail-copyable-text m-fio-link-text">
                      app.frame.io/{asset.frameIoReviewLink}
                    </span>
                    <button type="button" className="m-copy-btn" onClick={() => handleCopy(`https://app.frame.io/${asset.frameIoReviewLink}`, 'fio')}>
                      {copied === 'fio' ? '✓' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {/* Version history */}
              <div className="m-detail-section">
                <h3 className="m-detail-section-title">Version History</h3>
                <div className="m-version-list">
                  {asset.versions.slice().reverse().map((v) => (
                    <div key={v.round} className="m-version-row">
                      <span className="m-version-round">R{v.round}</span>
                      <span className="m-version-action">{v.action === 'replaced' ? '↑ replaced' : '+ uploaded'}</span>
                      <span className="m-version-date">{v.uploadDate}</span>
                      <span className="m-version-uploader">{v.uploader}</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
        )}
      </aside>
    </>
  );
}
