/**
 * Frame.io V4 OAuth token store
 *
 * Persists access + refresh tokens to data/frameio-tokens.json.
 * Automatically refreshes the access token (using the long-lived refresh
 * token) whenever it is within 5 minutes of expiry — completely transparent
 * to callers.
 *
 * Users connect once via /api/auth/frameio/connect and never need to
 * re-authenticate unless they explicitly disconnect or Adobe revokes the
 * refresh token (extremely rare).
 */

import fs                                           from 'node:fs';
import path                                         from 'node:path';
import { hkdfSync, randomBytes, createCipheriv,
         createDecipheriv }                         from 'node:crypto';

const DATA_DIR   = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'frameio-tokens.json');

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const DEFAULT_REDIRECT_URI = 'https://localhost:3000/api/auth/frameio/callback';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredTokens {
  access_token:  string;
  refresh_token: string;
  expires_at:    string;   // ISO-8601
  connected_at:  string;   // ISO-8601 — when the user first connected
}

// ── Encryption helpers ────────────────────────────────────────────────────────
// AES-256-GCM, key derived from LPOS_AUTH_SECRET via HKDF-SHA256.
// On-disk format: base64( iv[12] || authTag[16] || ciphertext ).

function deriveKey(): Buffer {
  const secret = process.env.LPOS_AUTH_SECRET;
  if (!secret) throw new Error('LPOS_AUTH_SECRET is not set — cannot encrypt Frame.io tokens');
  return Buffer.from(
    hkdfSync('sha256', secret, 'lpos-frameio-tokens-v1', '', 32),
  );
}

function encryptTokens(tokens: StoredTokens): string {
  const key        = deriveKey();
  const iv         = randomBytes(12);
  const cipher     = createCipheriv('aes-256-gcm', key, iv);
  const plaintext  = JSON.stringify(tokens);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptTokens(encoded: string): StoredTokens {
  const key        = deriveKey();
  const buf        = Buffer.from(encoded, 'base64');
  const iv         = buf.subarray(0, 12);
  const authTag    = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher   = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext  = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as StoredTokens;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function read(): StoredTokens | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();

    // Try encrypted format first (base64 blob).
    try {
      return decryptTokens(raw);
    } catch {
      // Legacy: plaintext JSON written before encryption was added.
      // Decrypt failed — attempt plain parse, then immediately re-write encrypted.
      const legacy = JSON.parse(raw) as StoredTokens;
      console.log('[frameio-tokens] migrating token file to encrypted format…');
      write(legacy);
      return legacy;
    }
  } catch {
    return null;
  }
}

function write(tokens: StoredTokens): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, encryptTokens(tokens), 'utf-8');
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh(refreshToken: string): Promise<StoredTokens> {
  const clientId     = process.env.FRAMEIO_CLIENT_ID?.trim();
  const clientSecret = process.env.FRAMEIO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('FRAMEIO_CLIENT_ID / FRAMEIO_CLIENT_SECRET not set in .env.local');
  }

  console.log('[frameio-tokens] refreshing access token via Adobe IMS…');

  const res = await fetch(IMS_TOKEN_URL, {
    method:  'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(body) as {
        error?: string;
        jump?: string;
      };
      if (parsed.error === 'ride_AdobeID_acct_actreq') {
        throw new Error(
          'Adobe requires the connected account to complete an account action before refresh can succeed. ' +
          `Reconnect Frame.io and finish the Adobe prompt: ${parsed.jump ?? process.env.FRAMEIO_REDIRECT_URI?.trim() ?? DEFAULT_REDIRECT_URI}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Adobe requires the connected account')) {
        throw error;
      }
    }
    throw new Error(`Adobe IMS token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token:   string;
    refresh_token?: string;   // some providers rotate, some don't
    expires_in:     number;
  };

  const existing = read();
  const updated: StoredTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    connected_at:  existing?.connected_at ?? new Date().toISOString(),
  };

  write(updated);
  console.log('[frameio-tokens] token refreshed, expires', updated.expires_at);
  return updated;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a valid access token, silently refreshing if needed.
 * Throws if not connected or if refresh fails.
 */
export async function getValidAccessToken(): Promise<string> {
  const tokens = read();
  if (!tokens) {
    throw new Error(
      'Frame.io is not connected. ' +
      'Visit https://localhost:3000/api/auth/frameio/connect to authenticate.',
    );
  }

  const expiresAt = new Date(tokens.expires_at).getTime();
  const fiveMin   = 5 * 60 * 1000;

  if (Date.now() < expiresAt - fiveMin) {
    return tokens.access_token;   // still fresh
  }

  const refreshed = await refresh(tokens.refresh_token);
  return refreshed.access_token;
}

/**
 * Store tokens received from the OAuth callback.
 */
export function storeTokens(data: {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;
}): void {
  write({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    connected_at:  new Date().toISOString(),
  });
  console.log('[frameio-tokens] tokens stored');
}

/** True if a token file exists (user has connected at some point). */
export function isConnected(): boolean {
  return read() !== null;
}

/** Connected-at timestamp, or null. */
export function connectedAt(): string | null {
  return read()?.connected_at ?? null;
}

/** Remove stored tokens (disconnect). */
export function disconnect(): void {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }
  console.log('[frameio-tokens] disconnected');
}
