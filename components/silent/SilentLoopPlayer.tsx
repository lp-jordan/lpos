'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Full-bleed, muted, infinitely-looping video for the silent display pages.
 *
 * Deliberately has no controls, no audio, and no chrome — it is meant to be
 * left running on a screen indefinitely. `muted` is load-bearing, not just a
 * preference: Chrome blocks autoplay outright for unmuted media.
 *
 * The watchdog exists because a display left running for days will eventually
 * hit a decode hiccup or a browser tab throttle that leaves the element paused
 * with nobody around to click play.
 */
export function SilentLoopPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Nudge playback back to life if it ever stops on its own.
    const kick = () => {
      if (video.paused && !video.ended) void video.play().catch(() => { /* retried next tick */ });
    };

    const onEnded = () => {
      // `loop` normally makes this unreachable, but some codecs fire `ended`
      // anyway on the final frame — restart rather than freeze on black.
      video.currentTime = 0;
      void video.play().catch(() => { /* retried by the watchdog */ });
    };

    const watchdog = setInterval(kick, 5000);
    video.addEventListener('ended', onEnded);
    video.addEventListener('stalled', kick);
    document.addEventListener('visibilitychange', kick);

    void video.play().catch(() => { /* watchdog picks it up */ });

    return () => {
      clearInterval(watchdog);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('stalled', kick);
      document.removeEventListener('visibilitychange', kick);
    };
  }, [src]);

  if (failed) {
    return (
      <div className="silent-page-message">
        <p>This video could not be played.</p>
        <p className="silent-page-message-sub">
          The browser may not support its codec. Choose an H.264 MP4 in Settings → Media → Silent pages.
        </p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      className="silent-page-video"
      src={src}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      disablePictureInPicture
      onError={() => setFailed(true)}
    />
  );
}
