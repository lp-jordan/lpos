/**
 * Daily guest PIN
 *
 * Generates a deterministic 4-digit PIN from today's UTC date and
 * LPOS_AUTH_SECRET via HMAC-SHA256. No storage required — the same PIN is
 * re-derived on every call until midnight UTC, then it automatically changes.
 *
 * The PIN is intentionally plaintext-displayable (admin panel shows it to
 * operators) and is only a soft access gate for walk-up studio clients.
 */

import { createHmac } from 'node:crypto';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getSecret(): string {
  const secret = process.env.LPOS_AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LPOS_AUTH_SECRET environment variable must be set in production.');
    }
    return 'lpos-dev-secret-change-me';
  }
  return secret;
}

export function getTodayPin(): string {
  const secret = getSecret();
  const hmac = createHmac('sha256', secret)
    .update(`lpos-guest-pin:${todayUtc()}`)
    .digest();
  const num = hmac.readUInt32BE(0) % 10000;
  return String(num).padStart(4, '0');
}

export function verifyGuestPin(input: string): boolean {
  return typeof input === 'string' && input.trim() === getTodayPin();
}
