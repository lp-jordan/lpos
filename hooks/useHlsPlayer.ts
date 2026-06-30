'use client';

import { useEffect } from 'react';
import type { RefObject } from 'react';

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
 * prop from the element — the hook owns it.
 */

const HLS_RE = /\.m3u8(\?|#|$)/i;

export function useHlsPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string,
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let destroyed = false;
    let hls: { destroy(): void } | null = null;

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

      const isHls     = HLS_RE.test(url);
      const nativeHls = videoRef.current.canPlayType('application/vnd.apple.mpegurl') !== '';

      if (isHls && !nativeHls) {
        const { default: Hls } = await import('hls.js');
        if (destroyed || !videoRef.current) return;
        if (Hls.isSupported()) {
          const inst = new Hls({ enableWorker: true });
          inst.loadSource(url);
          inst.attachMedia(videoRef.current);
          hls = inst;
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
      if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
      const v = videoRef.current;
      if (v) { v.removeAttribute('src'); v.load(); }
    };
  // videoRef is a stable ref; re-run only when the source changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
}
