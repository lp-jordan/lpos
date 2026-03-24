/**
 * GET /api/auth/frameio/callback
 *
 * Adobe IMS redirects here after the user authorises LPOS.
 * Exchanges the one-time `code` for access + refresh tokens,
 * persists them to data/frameio-tokens.json, then redirects
 * back to the media page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { storeTokens } from '@/lib/services/frameio-tokens';

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';

function html(title: string, body: string) {
  return new NextResponse(
    `<!DOCTYPE html><html><head><title>${title}</title>
     <style>body{font-family:sans-serif;padding:2rem;max-width:600px;margin:auto}
     pre{background:#f4f4f4;padding:1rem;border-radius:6px;overflow:auto}
     a{color:#0070f3}</style></head>
     <body><h2>${title}</h2>${body}</body></html>`,
    { headers: { 'Content-Type': 'text/html' } },
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code  = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDesc = searchParams.get('error_description');

  // ── OAuth error from Adobe ─────────────────────────────────────────────────
  if (error) {
    return html(
      'Frame.io — Connection Failed',
      `<p><strong>${error}</strong>${errorDesc ? `: ${errorDesc}` : ''}</p>
       <p><a href="/media">← Back to Media</a></p>`,
    );
  }

  if (!code) {
    return html(
      'Frame.io — No Code',
      `<p>Adobe did not return an authorization code. Try connecting again.</p>
       <p><a href="/api/auth/frameio/connect">Retry</a> · <a href="/media">Cancel</a></p>`,
    );
  }

  // ── Exchange code for tokens ───────────────────────────────────────────────
  const clientId     = process.env.FRAMEIO_CLIENT_ID?.trim();
  const clientSecret = process.env.FRAMEIO_CLIENT_SECRET?.trim();
  const redirectUri  = process.env.FRAMEIO_REDIRECT_URI?.trim()
    ?? 'https://localhost:3000/api/auth/frameio/callback';

  if (!clientId || !clientSecret) {
    return html(
      'Frame.io — Config Error',
      `<p>FRAMEIO_CLIENT_ID or FRAMEIO_CLIENT_SECRET is not set in .env.local.</p>`,
    );
  }

  const tokenRes = await fetch(IMS_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    return html(
      'Frame.io — Token Exchange Failed',
      `<p>Adobe IMS returned <strong>${tokenRes.status}</strong>.</p>
       <pre>${body}</pre>
       <p><a href="/api/auth/frameio/connect">Retry</a> · <a href="/media">Cancel</a></p>`,
    );
  }

  const tokenData = await tokenRes.json() as {
    access_token:   string;
    refresh_token:  string;
    expires_in:     number;
    token_type:     string;
  };

  if (!tokenData.access_token || !tokenData.refresh_token) {
    return html(
      'Frame.io — Unexpected Response',
      `<p>Adobe returned a response without the expected tokens.</p>
       <pre>${JSON.stringify(tokenData, null, 2)}</pre>`,
    );
  }

  storeTokens(tokenData);

  // ── Success — redirect back to the media page ──────────────────────────────
  const base = new URL(req.url);
  return NextResponse.redirect(new URL('/media', base));
}
