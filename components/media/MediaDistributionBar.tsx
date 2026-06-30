'use client';

import { useRef, useState } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';

/**
 * Compact distribution bar for the media detail sidebar. An icon action-rail
 * (Copy stream URL, Replace thumbnail, Security — each a single click straight
 * to its action/modal; Frame.io link) with a right-justified roll-up health dot:
 *   red    — something failed
 *   yellow — something is in progress or stale (CF reflects an older version)
 *   green  — everything settled
 * Hovering the dot reveals a per-platform breakdown (Frame.io · Cloudflare ·
 * Transcription). Control LOGIC stays in MediaDetailPanel (modals, push, copy).
 */

const HOVER_CLOSE_MS = 160;  // grace so moving icon → health popover doesn't dismiss

type Tone = 'ready' | 'processing' | 'failed' | 'stale' | 'idle';

function toneDot(tone: Tone): string {
  return tone === 'failed' ? 'red'
    : tone === 'processing' ? 'yellow'
    : tone === 'stale' ? 'amber'
    : tone === 'ready' ? 'green'
    : 'idle';
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

  function clearTimers() {
    if (openTimerRef.current)  { clearTimeout(openTimerRef.current);  openTimerRef.current = null; }
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }
  function scheduleClose() {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpenItem(null), HOVER_CLOSE_MS);
  }
  function openNow(key: string) { clearTimers(); setOpenItem(key); }   // health dot: instant
  function toggle(key: string)  { clearTimers(); setOpenItem((cur) => (cur === key ? null : key)); }

  // ── Derived Cloudflare state ───────────────────────────────────────────────
  const cf        = asset.cloudflare;
  const cfReady   = cf.status === 'ready';
  const isStale   = cf.isStale;
  const embedBase = cf.hlsUrl ? cf.hlsUrl.replace('/manifest/video.m3u8', '') : null;
  const embedSrc  = embedBase
    ? `${embedBase}/iframe${cf.posterUrl ? `?poster=${encodeURIComponent(cf.posterUrl)}` : ''}`
    : null;

  const cfTone: Tone =
    cf.status === 'ready'      ? (isStale ? 'stale' : 'ready')
    : cf.status === 'failed'   ? 'failed'
    : (cf.status === 'uploading' || cf.status === 'processing') ? 'processing'
    : 'idle';
  const cfLabel =
    cf.status === 'uploading'  ? `Uploading ${cf.progress ? `${cf.progress}%` : ''}`.trim()
    : cf.status === 'processing' ? 'Encoding'
    : cf.status === 'failed'    ? 'Failed'
    : isStale                   ? 'Stale'
    : cfReady                   ? 'Ready'
    : 'Not uploaded';

  const fio = asset.frameio.status;
  const fioTone: Tone =
    fio === 'in_review' || fio === 'approved' ? 'ready'
    : fio === 'uploading' ? 'processing'
    : fio === 'rejected' || fio === 'needs_changes' ? 'stale'
    : 'idle';
  const fioLabel =
    fio === 'none' ? 'Not uploaded'
    : fio === 'uploading' ? 'Uploading'
    : fio === 'rejected' ? 'Rejected'
    : fio === 'needs_changes' ? 'Changes requested'
    : 'Ready';

  const tx = asset.transcription.status;
  const txTone: Tone =
    tx === 'done' ? 'ready' : tx === 'failed' ? 'failed'
    : (tx === 'queued' || tx === 'processing') ? 'processing' : 'idle';
  const txLabel = tx === 'done' ? 'Done' : tx === 'processing' ? 'Transcribing' : tx === 'queued' ? 'Queued' : 'None';

  // Roll-up health: red beats yellow beats green.
  const tones = [fioTone, cfTone, txTone];
  const overall: 'red' | 'yellow' | 'green' =
    tones.some((t) => t === 'failed')                     ? 'red'
    : tones.some((t) => t === 'processing' || t === 'stale') ? 'yellow'
    : 'green';

  // CF-backed actions only make sense for the current (CF) version.
  const showCfActions = cfReady && !isViewingOldVersion;

  return (
    <div className="mdb">
      <div className="mdb-rail">
        {showCfActions && embedSrc && (
          <div className="mdb-rail-item">
            <button
              type="button"
              className={`mdb-rail-btn${streamUrlCopied ? ' mdb-rail-btn--ok' : ''}`}
              onClick={() => onCopyStreamUrl(embedSrc)}
              aria-label="Copy stream URL"
              title="Copy stream URL"
            >
              {streamUrlCopied
                ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5"/></svg>}
            </button>
            {streamUrlCopied && <span className="mdb-copied" role="status">Copied!</span>}
          </div>
        )}

        {showCfActions && (
          <div className="mdb-rail-item">
            <button
              type="button"
              className="mdb-rail-btn"
              onClick={onReplaceThumbnail}
              aria-label="Replace thumbnail"
              title="Replace thumbnail"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            </button>
          </div>
        )}

        {showCfActions && cf.uid && (
          <div className="mdb-rail-item">
            <button
              type="button"
              className="mdb-rail-btn"
              onClick={onSecurity}
              aria-label="Security"
              title="Security — domain restrictions & signed-URL requirements"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
          </div>
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

        {/* Roll-up health dot — right-justified; hover for the per-platform breakdown */}
        <div className="mdb-rail-item mdb-health" onMouseEnter={() => openNow('health')} onMouseLeave={scheduleClose}>
          <button type="button" className="mdb-dot-btn" aria-label="Distribution status" onClick={() => toggle('health')}>
            <span className={`mdb-dot mdb-dot--${overall}`} />
          </button>
          {openItem === 'health' && (
            <div className="mdb-pop mdb-health-pop" role="dialog" aria-label="Distribution status">
              <div className="mdb-health-row"><span className={`mdb-dot mdb-dot--${toneDot(fioTone)}`} /><span className="mdb-health-name">Frame.io</span><span className="mdb-health-state">{fioLabel}</span></div>
              <div className="mdb-health-row"><span className={`mdb-dot mdb-dot--${toneDot(cfTone)}`} /><span className="mdb-health-name">Cloudflare</span><span className="mdb-health-state">{cfLabel}</span></div>
              <div className="mdb-health-row"><span className={`mdb-dot mdb-dot--${toneDot(txTone)}`} /><span className="mdb-health-name">Transcription</span><span className="mdb-health-state">{txLabel}</span></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
