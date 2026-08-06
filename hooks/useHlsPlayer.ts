'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type HlsPlayer from 'hls.js';

/**
 * Attaches a media source to a <video> element, transparently handling HLS.
 *
 * The stream route (`…/frameio-stream`) 302-redirects to either a Cloudflare
 * HLS manifest (`.m3u8` — the current version) or a Frame.io H.264 MP4 (older
 * versions and the fallback path). MP4 plays natively in every browser. For
 * HLS we PREFER hls.js wherever it's supported (Chrome, Edge, Firefox, desktop
 * Safari) — Chromium browsers report a bogus `canPlayType('…mpegurl') = "maybe"`
 * but play multi-rendition HLS poorly through the native element and expose no
 * rendition control. Native playback is the fallback only when hls.js can't run
 * (iOS Safari). hls.js is lazy-loaded so it ships only to clients that need it.
 *
 * Usage: call this in place of setting `src` on the <video>; remove the `src`
 * prop from the element — the hook owns it. The returned controller exposes a
 * quality toggle (Auto ⇄ full resolution); it's inert for native-HLS/MP4.
 */

const HLS_RE = /\.m3u8(\?|#|$)/i;

// Optimistic cold-start bandwidth (5 Mbps). hls.js seeds its ABR estimate from
// this on the very first segment; its own default (~0.5 Mbps) is what makes a
// video open at a low rendition and visibly climb to full quality over the
// first few seconds. ABR still steps DOWN immediately if the real connection
// can't sustain the higher rendition — this only removes the pessimistic start.
const START_BW_ESTIMATE = 5_000_000;

export type QualityMode = 'auto' | 'max';

export interface HlsController {
  /** hls.js is driving playback AND the stream has >1 rendition to choose. */
  hasLevels: boolean;
  /** 'auto' = adaptive bitrate; 'max' = pinned to the top rendition. */
  mode: QualityMode;
  /** Switch quality mode. No-op for native-HLS (Safari) / MP4 sources. */
  setMode: (m: QualityMode) => void;
}

export function useHlsPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string,
): HlsController {
  const [hasLevels, setHasLevels] = useState(false);
  const [mode, setModeState] = useState<QualityMode>('auto');

  const hlsRef      = useRef<HlsPlayer | null>(null);
  const topLevelRef = useRef(-1);              // highest rendition index (-1 = unknown)
  const modeRef     = useRef<QualityMode>('auto');

  const setMode = useCallback((m: QualityMode) => {
    modeRef.current = m;
    setModeState(m);
    const inst = hlsRef.current;
    if (!inst) return;
    // currentLevel: a fixed index pins the rendition (switches immediately);
    // -1 hands control back to adaptive bitrate.
    inst.currentLevel = m === 'max' && topLevelRef.current >= 0
      ? topLevelRef.current
      : -1;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // New source: forget levels, but KEEP the user's mode preference so an "HD"
    // choice sticks as they move between assets.
    setHasLevels(false);
    topLevelRef.current = -1;

    let destroyed = false;
    let hls: HlsPlayer | null = null;

    void (async () => {
      // Resolve the route to its final media URL so we can tell HLS from MP4.
      // `?raw` returns the redirect target as JSON instead of issuing a 302.
      let url = src;
      if (src.includes('/frameio-stream')) {
        try {
          const res = await fetch(src.includes('?') ? `${src}&raw=1` : `${src}?raw=1`);
          if (res.ok) {
            const data = await res.json() as { url?: string };
            if (data.url) url = data.url;
          }
        } catch { /* fall back to the route URL — the browser follows the 302 */ }
      }
      if (destroyed || !videoRef.current) return;

      const el        = videoRef.current;
      const isHls     = HLS_RE.test(url);
      const nativeHls = el.canPlayType('application/vnd.apple.mpegurl') !== '';

      // TEMP DIAGNOSTIC — remove once the quality-button issue is understood.
      console.info('[useHlsPlayer] resolve', { src, url, isHls, nativeHls });

      // Prefer hls.js whenever MSE is available (Chrome, Edge, Firefox, desktop
      // Safari). Do NOT gate on `!nativeHls`: Chromium reports nativeHls=true yet
      // gives no rendition control, so that gate wrongly excluded the browsers we
      // want hls.js for. Native playback is the fallback for iOS Safari, where the
      // clientBandwidthHint on the manifest still biases the opening quality.
      if (isHls) {
        const { default: Hls } = await import('hls.js');
        if (destroyed || !videoRef.current) return;
        if (Hls.isSupported()) {
          const inst = new Hls({
            enableWorker: true,
            abrEwmaDefaultEstimate: START_BW_ESTIMATE,
          });
          hlsRef.current = inst;

          inst.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            topLevelRef.current = data.levels.length - 1;
            setHasLevels(data.levels.length > 1);
            // TEMP DIAGNOSTIC
            console.info('[useHlsPlayer] MANIFEST_PARSED', {
              levelCount: data.levels.length,
              levels: data.levels.map(l => ({ height: l.height, bitrate: l.bitrate })),
              hasLevels: data.levels.length > 1,
            });
            // Re-apply a sticky 'max' preference to the freshly loaded stream.
            if (modeRef.current === 'max' && topLevelRef.current >= 0) {
              inst.currentLevel = topLevelRef.current;
            }
          });

          // TEMP DIAGNOSTIC — what rendition ABR actually settles on, and why.
          inst.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
            console.info('[useHlsPlayer] LEVEL_SWITCHED', { level: data.level, top: topLevelRef.current });
          });
          inst.on(Hls.Events.ERROR, (_e, data) => {
            console.warn('[useHlsPlayer] ERROR', { type: data.type, details: data.details, fatal: data.fatal });
          });

          inst.loadSource(url);
          inst.attachMedia(el);
          hls = inst;
          return;
        }
        // hls.js can't run (iOS Safari / very old browser) → native element.
      }

      // TEMP DIAGNOSTIC
      console.info('[useHlsPlayer] native/mp4 path (no hls.js)', { url, isHls, nativeHls });
      // Native HLS (iOS Safari) or a plain MP4 — let the element handle it.
      if (videoRef.current) videoRef.current.src = url;
    })();

    return () => {
      destroyed = true;
      if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
      hlsRef.current = null;
      const v = videoRef.current;
      if (v) { v.removeAttribute('src'); v.load(); }
    };
  // videoRef is a stable ref; re-run only when the source changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return { hasLevels, mode, setMode };
}
