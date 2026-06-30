'use client';

import { useRef, useState } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';

/**
 * Compact distribution bar for the media detail sidebar (Option-A redesign):
 * a unified status strip (Frame.io review · Cloudflare playback · Transcription)
 * plus an icon action-rail whose full labeled controls reveal on a deliberate
 * 1-second hover (or tap on touch). Replaces the verbose Cloudflare section and
 * the three separate status displays so comments dominate the panel.
 *
 * The control LOGIC stays in MediaDetailPanel (modals, push, copy) and is passed
 * down as callbacks; this component owns only presentation + the reveal gesture.
 */

const HOVER_OPEN_MS  = 1000; // deliberate hold before a rail control reveals
const HOVER_CLOSE_MS = 160;  // grace so moving icon → popover doesn't dismiss

type StripTone = 'ready' | 'processing' | 'failed' | 'stale' | 'idle';

interface BadgeProps {
  icon: React.ReactNode;
  label: string;
  tone: StripTone;
  title?: string;
}

function StatusBadge({ icon, label, tone, title }: BadgeProps) {
  return (
    <span className={`mdb-badge mdb-badge--${tone}`} title={title}>
      <span className="mdb-badge-ico" aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

interface Props {
  asset:               MediaAsset;
  isViewingOldVersion: boolean;
  streamUrlCopied:     boolean;
  onCopyStreamUrl:     (embedSrc: string) => void;
  onReplaceThumbnail:  () => void;
  onSecurity:          () => void;
  frameioLink:         string | null;
}

export function MediaDistributionBar({
  asset, isViewingOldVersion, streamUrlCopied,
  onCopyStreamUrl, onReplaceThumbnail, onSecurity, frameioLink,
}: Readonly<Props>) {
  const [openItem, setOpenItem] = useState<string | null>(null);
  const openTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleOpen(key: string) {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    openTimerRef.current = setTimeout(() => setOpenItem(key), HOVER_OPEN_MS);
  }
  function scheduleClose() {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpenItem(null), HOVER_CLOSE_MS);
  }
  function toggle(key: string) {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
    setOpenItem((cur) => (cur === key ? null : key));
  }

  // ── Derived Cloudflare state (mirrors the old CF section) ──────────────────
  const cf        = asset.cloudflare;
  const cfReady   = cf.status === 'ready';
  const isStale   = cf.isStale;
  const embedBase = cf.hlsUrl ? cf.hlsUrl.replace('/manifest/video.m3u8', '') : null;
  const embedSrc  = embedBase
    ? `${embedBase}/iframe${cf.posterUrl ? `?poster=${encodeURIComponent(cf.posterUrl)}` : ''}`
    : null;
  const posterPreviewUrl = cf.posterUrl ?? (embedBase ? `${embedBase}/thumbnails/thumbnail.jpg` : null);

  const cfTone: StripTone =
    cf.status === 'ready'      ? (isStale ? 'stale' : 'ready')
    : cf.status === 'failed'   ? 'failed'
    : (cf.status === 'uploading' || cf.status === 'processing') ? 'processing'
    : 'idle';
  const cfLabel =
    cf.status === 'uploading'  ? `Uploading ${cf.progress ? `${cf.progress}%` : ''}`.trim()
    : cf.status === 'processing' ? 'Encoding'
    : cf.status === 'failed'    ? 'CF failed'
    : isStale                   ? 'Stale'
    : cfReady                   ? 'Playback'
    : 'No CF';

  const fio = asset.frameio.status;
  const fioTone: StripTone =
    fio === 'in_review' || fio === 'approved' ? 'ready'
    : fio === 'uploading' ? 'processing'
    : fio === 'rejected' || fio === 'needs_changes' ? 'stale'
    : 'idle';
  const fioLabel =
    fio === 'none' ? 'No review'
    : fio === 'uploading' ? 'Uploading'
    : fio === 'rejected' ? 'Rejected'
    : fio === 'needs_changes' ? 'Changes'
    : 'Review';

  const tx = asset.transcription.status;
  const txTone: StripTone =
    tx === 'done' ? 'ready' : tx === 'failed' ? 'failed'
    : (tx === 'queued' || tx === 'processing') ? 'processing' : 'idle';
  const txLabel = tx === 'done' ? 'Captions' : tx === 'processing' ? 'Transcribing' : tx === 'queued' ? 'Queued' : 'No captions';

  // CF-backed actions only make sense for the current (CF) version.
  const showCfActions = cfReady && !isViewingOldVersion;

  function railItem(
    key: string,
    label: string,
    icon: React.ReactNode,
    popover: React.ReactNode,
  ) {
    const open = openItem === key;
    return (
      <div
        className="mdb-rail-item"
        onMouseEnter={() => scheduleOpen(key)}
        onMouseLeave={scheduleClose}
      >
        <button
          type="button"
          className={`mdb-rail-btn${open ? ' is-open' : ''}`}
          aria-label={label}
          aria-expanded={open}
          onClick={() => toggle(key)}
        >
          {icon}
        </button>
        {open && (
          <div className="mdb-pop" role="dialog" aria-label={label}>
            <div className="mdb-pop-title">{label}</div>
            {popover}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mdb">
      <div className="mdb-strip">
        <StatusBadge
          tone={fioTone}
          label={fioLabel}
          title="Frame.io — client review &amp; comments. Where reviewers watch and leave timestamped notes."
          icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>}
        />
        <StatusBadge
          tone={cfTone}
          label={cfLabel}
          title={isStale ? 'Cloudflare — in-app playback. Reflects an older version; re-push from Advanced to update.' : 'Cloudflare — in-app playback. Streams this video in the LPOS player and powers scrub thumbnails.'}
          icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
        />
        <StatusBadge
          tone={txTone}
          label={txLabel}
          title="Transcription — captions/subtitles. A text transcript generated from the audio."
          icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>}
        />
      </div>

      <div className="mdb-rail">
        {showCfActions && embedSrc && railItem(
          'url',
          'Stream URL',
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>,
          <>
            <div className="mdb-pop-url">{embedSrc}</div>
            <button type="button" className="mdb-pop-btn" onClick={() => onCopyStreamUrl(embedSrc)}>
              {streamUrlCopied ? 'Copied!' : 'Copy stream URL'}
            </button>
          </>,
        )}

        {showCfActions && posterPreviewUrl && railItem(
          'thumb',
          'Thumbnail',
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>,
          <>
            <img className="mdb-pop-thumb" src={posterPreviewUrl} alt="Current poster" />
            <button type="button" className="mdb-pop-btn" onClick={onReplaceThumbnail}>Replace…</button>
          </>,
        )}

        {showCfActions && cf.uid && railItem(
          'security',
          'Security',
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
          <>
            <div className="mdb-pop-note">Domain restrictions and signed-URL requirements for this video.</div>
            <button type="button" className="mdb-pop-btn" onClick={onSecurity}>Open security</button>
          </>,
        )}

        {frameioLink && (
          <a
            className="mdb-rail-btn"
            href={frameioLink}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in Frame.io"
            title="Open in Frame.io"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        )}
      </div>
    </div>
  );
}
