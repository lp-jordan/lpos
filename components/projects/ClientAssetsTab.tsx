'use client';

import { useState } from 'react';

// ── Fake asset data ───────────────────────────────────────────────────────────

type AssetType = 'pdf' | 'docx' | 'png' | 'jpg' | 'mp4' | 'zip';

type FakeAsset = {
  id: string;
  name: string;
  type: AssetType;
  size: string;
  uploadedBy: string;
  uploadedAt: string;
  sendToScripts?: boolean;
};

const FAKE_ASSETS: FakeAsset[] = [
  // Documents
  { id: 'f1', name: 'Brand Guidelines 2025.pdf',        type: 'pdf',  size: '4.2 MB',  uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 14, 2025', sendToScripts: true },
  { id: 'f2', name: 'Campaign Brief — Spring.docx',     type: 'docx', size: '890 KB',  uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 14, 2025', sendToScripts: true },
  { id: 'f3', name: 'Q1 Strategy Deck.pdf',             type: 'pdf',  size: '11.7 MB', uploadedBy: 'Marcus T.',    uploadedAt: 'Mar 11, 2025', sendToScripts: true },
  { id: 'f4', name: 'Onboarding Checklist.docx',        type: 'docx', size: '240 KB',  uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 10, 2025', sendToScripts: true },
  { id: 'f5', name: 'Messaging Framework v3.pdf',       type: 'pdf',  size: '1.8 MB',  uploadedBy: 'Marcus T.',    uploadedAt: 'Mar 9,  2025', sendToScripts: true },
  // Brand assets
  { id: 'f6', name: 'Logo — Full Color.png',            type: 'png',  size: '320 KB',  uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 14, 2025' },
  { id: 'f7', name: 'Logo — White Knockout.png',        type: 'png',  size: '290 KB',  uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 14, 2025' },
  { id: 'f8', name: 'Logo — Dark.png',                  type: 'png',  size: '305 KB',  uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 14, 2025' },
  { id: 'f9', name: 'Brand Color Palette.png',          type: 'png',  size: '88 KB',   uploadedBy: 'Sarah K.',     uploadedAt: 'Mar 13, 2025' },
  { id: 'f10', name: 'Hero Image — Office.jpg',         type: 'jpg',  size: '3.1 MB',  uploadedBy: 'Marcus T.',    uploadedAt: 'Mar 12, 2025' },
  { id: 'f11', name: 'Headshot — CEO.jpg',              type: 'jpg',  size: '1.4 MB',  uploadedBy: 'Marcus T.',    uploadedAt: 'Mar 12, 2025' },
  { id: 'f12', name: 'Team Photo — Full.jpg',           type: 'jpg',  size: '5.6 MB',  uploadedBy: 'Marcus T.',    uploadedAt: 'Mar 11, 2025' },
];

// ── Type metadata ─────────────────────────────────────────────────────────────

const TYPE_META: Record<AssetType, { label: string; color: string; icon: React.ReactNode }> = {
  pdf: {
    label: 'PDF',
    color: '#e8706a',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h4"/>
      </svg>
    ),
  },
  docx: {
    label: 'DOCX',
    color: '#5b9cf6',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <path d="M9 13h6M9 17h6"/>
      </svg>
    ),
  },
  png: {
    label: 'PNG',
    color: '#7ec87e',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    ),
  },
  jpg: {
    label: 'JPG',
    color: '#c4a35a',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    ),
  },
  mp4: {
    label: 'MP4',
    color: '#a78bfa',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2"/>
      </svg>
    ),
  },
  zip: {
    label: 'ZIP',
    color: '#94a3b8',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
      </svg>
    ),
  },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string;
  projectName: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ClientAssetsTab({ projectId, projectName }: Props) {
  const [copied,        setCopied]        = useState(false);
  const [sentToScripts, setSentToScripts] = useState<Set<string>>(new Set());
  const [filter,        setFilter]        = useState<'all' | AssetType>('all');

  // Fake persistent URL derived from project
  const slug       = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const clientUrl  = `https://assets.leaderpass.co/c/${slug}`;

  function handleCopy() {
    void navigator.clipboard.writeText(clientUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleShare() {
    void navigator.clipboard.writeText(clientUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSendToScripts(id: string) {
    setSentToScripts((prev) => new Set([...prev, id]));
  }

  const filtered = filter === 'all'
    ? FAKE_ASSETS
    : FAKE_ASSETS.filter((a) => a.type === filter);

  const docCount   = FAKE_ASSETS.filter((a) => a.type === 'pdf' || a.type === 'docx').length;
  const imageCount = FAKE_ASSETS.filter((a) => a.type === 'png' || a.type === 'jpg').length;

  return (
    <div className="ca-tab proj-tab-content page-stack">

      {/* ── Portal URL bar ── */}
      <div className="ca-url-bar">
        <div className="ca-url-bar-left">
          <div className="ca-url-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
          </div>
          <div className="ca-url-info">
            <span className="ca-url-label">Client Upload Portal</span>
            <span className="ca-url-value">{clientUrl}</span>
          </div>
        </div>
        <div className="ca-url-actions">
          <button type="button" className="ca-url-copy" onClick={handleCopy} title="Copy link">
            {copied
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            }
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button type="button" className="ca-url-share" onClick={handleShare}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            Share
          </button>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="ca-stats">
        <div className="ca-stat">
          <span className="ca-stat-num">{FAKE_ASSETS.length}</span>
          <span className="ca-stat-label">Total files</span>
        </div>
        <div className="ca-stat-divider" />
        <div className="ca-stat">
          <span className="ca-stat-num">{docCount}</span>
          <span className="ca-stat-label">Documents</span>
        </div>
        <div className="ca-stat-divider" />
        <div className="ca-stat">
          <span className="ca-stat-num">{imageCount}</span>
          <span className="ca-stat-label">Images</span>
        </div>
        <div className="ca-stat-divider" />
        <div className="ca-stat">
          <span className="ca-stat-num">2</span>
          <span className="ca-stat-label">Contributors</span>
        </div>
      </div>

      {/* ── Filter pills ── */}
      <div className="ca-filters">
        {(['all', 'pdf', 'docx', 'png', 'jpg'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`ca-filter-pill${filter === f ? ' ca-filter-pill--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? `All (${FAKE_ASSETS.length})` : f.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── Asset list ── */}
      <div className="ca-asset-list">
        {filtered.map((asset) => {
          const meta    = TYPE_META[asset.type];
          const sent    = sentToScripts.has(asset.id);
          return (
            <div key={asset.id} className="ca-asset-row">
              {/* Type icon */}
              <div className="ca-asset-icon" style={{ color: meta.color }}>
                {meta.icon}
              </div>

              {/* Name + meta */}
              <div className="ca-asset-info">
                <span className="ca-asset-name">{asset.name}</span>
                <span className="ca-asset-meta">
                  <span className="ca-asset-badge" style={{ color: meta.color, borderColor: `${meta.color}44`, background: `${meta.color}12` }}>
                    {meta.label}
                  </span>
                  <span>{asset.size}</span>
                  <span>·</span>
                  <span>Uploaded by {asset.uploadedBy}</span>
                  <span>·</span>
                  <span>{asset.uploadedAt}</span>
                </span>
              </div>

              {/* Actions */}
              <div className="ca-asset-actions">
                {asset.sendToScripts && (
                  <button
                    type="button"
                    className={`ca-asset-btn ca-asset-btn--scripts${sent ? ' ca-asset-btn--sent' : ''}`}
                    onClick={() => handleSendToScripts(asset.id)}
                    disabled={sent}
                  >
                    {sent
                      ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg> In Scripts</>
                      : '→ Scripts'
                    }
                  </button>
                )}
                <button type="button" className="ca-asset-btn" title="Download">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Upload prompt ── */}
      <div className="ca-upload-prompt">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <div>
          <p className="ca-upload-prompt-title">Client uploads appear here automatically</p>
          <p className="ca-upload-prompt-sub">Share the portal link above and files will sync as they come in.</p>
        </div>
      </div>

    </div>
  );
}
