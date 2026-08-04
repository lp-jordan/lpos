'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type HlsPlayer from 'hls.js';

/**
 * Attaches a media source to a <video> element, transparently handling HLS.
 *
 * The stream route (`…/frameio-stream`) 302-redirects to either a Cloudflare
 * HLS manifest (`.m3u8` — the current version) or a Frame.io H.264 MP4 (older
 * versions and the fallback path). MP4 plays natively in every browser; HLS
 * plays natively ONLY in Safari. So for an HLS source in a browser without
 * native HLS (Firefox, Chrome) we attach via hls.js — lazy-loaded so it only
 * ships to clients that actually need it.
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

  // Live handles the control methods reach into without re-running the effect.
  const hlsRef            = useRef<HlsPlayer | null>(null);
  const topLevelRef       = useRef(-1);              // highest rendition index (-1 = unknown)
  const modeRef           = useRef<QualityMode>('auto');
  const bandwidthKnownRef = useRef(false);           // ABR confirmed top is sustainable

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

    // New source: forget what we learned, but KEEP the user's mode preference
    // so an "HD" choice sticks as they move between assets.
    setHasLevels(false);
    topLevelRef.current = -1;
    bandwidthKnownRef.current = false;

    let destroyed = false;
    let hls: HlsPlayer | null = null;
    let detach: (() => void) | null = null;

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

      if (isHls && !nativeHls) {
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
            // Re-apply a sticky 'max' preference to the freshly loaded stream.
            if (modeRef.current === 'max' && topLevelRef.current >= 0) {
              inst.currentLevel = topLevelRef.current;
            }
          });

          // Once ABR has actually reached the top rendition we KNOW full-res is
          // sustainable on this connection — this gates the rewind fast-path.
          inst.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
            if (topLevelRef.current >= 0 && data.level >= topLevelRef.current) {
              bandwidthKnownRef.current = true;
            }
          });

          inst.loadSource(url);
          inst.attachMedia(el);
          hls = inst;

          // Rewind fast-path: when the viewer scrubs BACK toward the start after
          // we've already confirmed full-res is sustainable, force the seeked-to
          // segment to the top rendition (one-shot) so the replay is sharp from
          // frame one instead of re-ramping. Skipped when 'max' is already pinned.
          let lastTime = 0;
          const onTimeUpdate = () => { lastTime = el.currentTime; };
          const onSeeking = () => {
            if (modeRef.current === 'max') return;         // already pinned to top
            if (!bandwidthKnownRef.current) return;        // never reached full-res yet
            if (topLevelRef.current < 0) return;
            if (el.currentTime >= lastTime - 0.5) return;  // only backward seeks
            inst.nextLevel = topLevelRef.current;          // force next fragment high…
            const reset = () => {
              inst.nextLevel = -1;                         // …then hand back to ABR
              inst.off(Hls.Events.FRAG_CHANGED, reset);
            };
            inst.on(Hls.Events.FRAG_CHANGED, reset);
          };
          el.addEventListener('timeupdate', onTimeUpdate);
          el.addEventListener('seeking', onSeeking);
          detach = () => {
            el.removeEventListener('timeupdate', onTimeUpdate);
            el.removeEventListener('seeking', onSeeking);
          };
          return;
        }
        // hls.js unsupported (very old browser) → fall through to native, which
        // will fail gracefully into the player's "Check back shortly" state.
      }

      // Native HLS (Safari) or a plain MP4 — let the element handle it.
      if (videoRef.current) videoRef.current.src = url;
    })();

    return () => {
      destroyed = true;
      if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
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
