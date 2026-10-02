/**
 * Compile-time feature switches for parked features. Flip a flag to bring the
 * feature back — the underlying code is kept intact on purpose.
 */

/** Studio → Presentation tab (slides on studio guest devices). Parked 2026-10-02:
 *  never used in production. When false: the Studio pill is hidden, the guest
 *  home tile is hidden, plain guests on /slate are sent back to /guest, and the
 *  credential-less /api/auth/join/presentation link no longer issues sessions. */
export const STUDIO_PRESENTATION_ENABLED = false;
