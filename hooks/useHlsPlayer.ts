'use client';

import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Attaches a video source to a <video> element.
 *
 * Frame.io assets redirect to an H.264 MP4 transcode — all browsers play this
 * natively via Range requests, no hls.js needed. Local NAS streams are set
 * directly. Safari handles both natively as well.
 *
 * Usage: call this hook in place of setting `src` on the <video> element.
 * Remove the `src` prop from the element; the hook manages it.
 */
export function useHlsPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string,
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    video.src = src;

    return () => {
      video.removeAttribute('src');
      video.load();
    };
  // videoRef is a stable ref object — including it satisfies the linter
  // without causing spurious re-runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
}
