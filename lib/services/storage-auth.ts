import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { readStorageConfig } from '@/lib/store/storage-config-store';

const COOKIE_NAME = 'lpos_storage_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function getSessionSecret(): string {
  return process.env.LPOS_STORAGE_AUTH_SECRET?.trim()
    || createHash('sha256').update(process.cwd()).digest('hex');
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(pin, salt, 64).toString('hex');
  return `scrypt:${salt}:${digest}`;
}

export function verifyPin(pin: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const [scheme, salt, digest] = storedHash.split(':');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const derived = scryptSync(pin, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function sign(payload: string): string {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
}

export function createSessionToken(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = JSON.stringify({ expiresAt });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

export function isStorageAdminRequest(req: NextRequest): boolean {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;
  if (sign(encoded) !== signature) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { expiresAt?: number };
    return typeof payload.expiresAt === 'number' && payload.expiresAt > Date.now();
  } catch {
    return false;
  }
}

export function getStorageAdminCookie() {
  return {
    name: COOKIE_NAME,
    value: createSessionToken(),
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    },
  };
}

export function getClearedStorageAdminCookie() {
  return {
    name: COOKIE_NAME,
    value: '',
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    },
  };
}

export function storageAuthSummary(req: NextRequest): { bootstrapped: boolean; unlocked: boolean } {
  void req;
  readStorageConfig();
  return {
    bootstrapped: true,
    unlocked: true,
  };
}
