/** Broadcast start timecode offset: 01:00:00:00 = 3600 s */
const START_TC_SECONDS = 3600;

/** 23.976 fps = 24000/1001 */
const FPS = 24000 / 1001;

/**
 * Format a video timestamp (seconds from file start) as SMPTE HH:MM:SS:FF,
 * applying the standard 01:00:00:00 broadcast start-timecode offset at 23.976 fps.
 */
export function formatTimecode(seconds: number): string {
  const total       = seconds + START_TC_SECONDS;
  const totalFrames = Math.floor(total * FPS);
  const ff = totalFrames % 24;
  const ss = Math.floor(totalFrames / 24) % 60;
  const mm = Math.floor(totalFrames / (24 * 60)) % 60;
  const hh = Math.floor(totalFrames / (24 * 3600));
  const p  = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
