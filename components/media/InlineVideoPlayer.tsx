'use client';

/**
 * InlineVideoPlayer
 *
 * Compact custom video player for the asset sidebar.
 * Same scrub bar / comment tick marks as VideoTheaterMode, but rendered
 * inline (no backdrop). Includes a theater-mode launch button.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import type { FrameIOComment } from '@/lib/services/frameio';
import { formatTimecode } from '@/lib/utils/time';

interface Props {
  src:             string;
  assetId:         string;          // used as React key to reset on asset change
  comments?:       FrameIOComment[];
  seekTarget?:     number | null;   // seek to this timestamp (seconds) when it changes
  onSeekHandled?:  () => void;
  onTheaterOpen:   () => void;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function InlineVideoPlayer({
  src, assetId, comments = [], seekTarget, onSeekHandled, onTheaterOpen,
}: Readonly<Props>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);

  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [muted,       setMuted]       = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // External seek (e.g. clicking a timed comment in the list below)
  useEffect(() => {
    if (seekTarget == null) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seekTarget;
    void v.play();
    onSeekHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTarget]);

  // Reset state when src changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setUnavailable(false);
  }, [src]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }, []);

  function handleScrubClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = scrubRef.current;
    const v  = videoRef.current;
    if (!el || !v || !duration) return;
    const rect = el.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration;
  }

  function seekTo(ts: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ts;
    void v.play();
  }

  const timedComments = comments.filter(c => c.timestamp !== null);

  return (
    <div className="ivp-root">
      {/* Video */}
      <div className="ivp-video-wrap" onClick={!unavailable ? togglePlay : undefined}>
        <video
          key={assetId}
          ref={videoRef}
          className="ivp-video"
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
          onError={() => setUnavailable(true)}
        />
        {unavailable ? (
          <div className="ivp-error-overlay">
            <span>Preview unavailable — Frame.io may still be processing</span>
            <button
              type="button"
              className="ivp-theater-btn"
              onClick={e => { e.stopPropagation(); onTheaterOpen(); }}
              title="Try theater mode"
              aria-label="Open in theater mode"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
              </svg>
            </button>
          </div>
        ) : (
          <>
            {/* Play/pause overlay — only visible when paused */}
            {!playing && (
              <div className="ivp-play-overlay" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </div>
            )}
            {/* Theater button — top-right corner */}
            <button
              type="button"
              className="ivp-theater-btn"
              onClick={e => { e.stopPropagation(); onTheaterOpen(); }}
              aria-label="Open in theater mode"
              title="Theater mode"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="ivp-controls">
        {/* Scrub bar */}
        <div className="ivp-scrub-wrap" ref={scrubRef} onClick={handleScrubClick}>
          <div className="ivp-scrub-track">
            <div
              className="ivp-scrub-fill"
              style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
            {duration > 0 && timedComments.map(c => {
              const pct = ((c.timestamp ?? 0) / duration) * 100;
              const tip = `${formatTimecode(c.timestamp ?? 0)}${c.duration ? ` → ${formatTimecode((c.timestamp ?? 0) + c.duration)}` : ''} — ${c.authorName || 'Frame.io'}: ${c.text}`;
              if (c.duration && c.duration > 0) {
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`ivp-scrub-range${c.completed ? ' ivp-scrub-range--done' : ''}`}
                    style={{ left: `${pct}%`, width: `${(c.duration / duration) * 100}%` }}
                    title={tip}
                    onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                    aria-label={`Jump to ${formatTimecode(c.timestamp ?? 0)}`}
                  />
                );
              }
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`ivp-scrub-tick${c.completed ? ' ivp-scrub-tick--done' : ''}`}
                  style={{ left: `${pct}%` }}
                  title={tip}
                  onClick={e => { e.stopPropagation(); seekTo(c.timestamp ?? 0); }}
                  aria-label={`Jump to ${formatTimecode(c.timestamp ?? 0)}`}
                />
              );
            })}
          </div>
        </div>

        {/* Bottom row: play, time, mute */}
        <div className="ivp-bottom-row">
          <button
            type="button"
            className="ivp-btn"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            )}
          </button>
          <span className="ivp-time">{fmt(currentTime)} / {fmt(duration)}</span>
          <div className="ivp-spacer" />
          {timedComments.length > 0 && (
            <span className="ivp-tick-count">{timedComments.length} comment{timedComments.length !== 1 ? 's' : ''}</span>
          )}
          <button
            type="button"
            className="ivp-btn"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              v.muted = !muted;
              setMuted(m => !m);
            }}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
