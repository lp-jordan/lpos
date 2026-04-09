export const APP_SESSION_COOKIE = 'lpos_session';
export const GOOGLE_STATE_COOKIE = 'lpos_google_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

import type { UserRole } from '@/lib/models/user';

export interface SessionPayload {
  userId: string;
  role: UserRole;
  expiresAt: number;
}

function getSessionSecret(): string {
  const secret = process.env.LPOS_AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LPOS_AUTH_SECRET environment variable must be set in production.');
    }
    return 'lpos-dev-secret-change-me';
  }
  return secret;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const chars = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodePayload(payload: SessionPayload): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePayload(encoded: string): SessionPayload | null {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(encoded));
    const payload = JSON.parse(json) as Partial<SessionPayload>;
    if (typeof payload.userId !== 'string' || typeof payload.expiresAt !== 'number') return null;
    // Backwards-compat: tokens issued before role was added default to 'user'.
    const role: UserRole = payload.role === 'admin' || payload.role === 'guest' ? payload.role : 'user';
    return { userId: payload.userId, role, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

async function importKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(value: string): Promise<string> {
  const key = await importKey();
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken(userId: string, role: UserRole): Promise<string> {
  const payload = encodePayload({
    userId,
    role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  const signature = await sign(payload);
  return `${payload}.${signature}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = await sign(encoded);
  if (signature !== expected) return null;

  const payload = decodePayload(encoded);
  if (!payload) return null;
  if (payload.expiresAt <= Date.now()) return null;
  return payload;
}

export function getSessionCookieOptions(maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export function clearSessionCookieOptions() {
  return getSessionCookieOptions(0);
}

export function createGoogleState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
