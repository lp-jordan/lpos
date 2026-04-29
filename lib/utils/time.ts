/**
 * Format a Frame.io NDF seconds value as SMPTE HH:MM:SS:FF.
 *
 * Frame.io stores comment timestamps as NDF frame counts (integer, 0-indexed
 * from the first frame of the file).  The service layer converts them to
 * "NDF seconds" by dividing by 24 (the nominal display frame rate).  Here we
 * multiply back by 24, add the standard 01:00:00:00 broadcast start-frame
 * offset (86400 = 24 × 3600), then apply pure NDF timecode arithmetic — no
 * floating-point fps multiplication that would drift over time.
 */
export function formatTimecode(ndfSeconds: number): string {
  const F  = Math.round(ndfSeconds * 24) + 86400; // total NDF frames incl. 01:00:00:00 offset
  const ff = F % 24;
  const ss = Math.floor(F / 24) % 60;
  const mm = Math.floor(F / 1440) % 60;
  const hh = Math.floor(F / 86400);
  const p  = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
