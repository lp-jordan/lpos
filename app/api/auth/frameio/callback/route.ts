/**
 * GET /api/auth/frameio/callback
 *
 * Adobe IMS redirects here after the user authorizes LPOS.
 * Exchanges the one-time `code` for access + refresh tokens,
 * persists them to data/frameio-tokens.json, then redirects
 * back to the media page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { storeTokens } from '@/lib/services/frameio-tokens';

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const DEFAULT_REDIRECT_URI = 'https://localhost:3000/api/auth/frameio/callback';

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

function renderOAuthError(error: string, errorDesc?: string | null) {
  if (error === 'ride_AdobeID_acct_actreq') {
    return html(
      'Frame.io - Adobe Account Action Required',
      `<p>Adobe needs you to complete a quick account step before Frame.io can connect.</p>
       <p>This is usually something like a password update, security check, or terms confirmation on the Adobe side.</p>
       <p>After you finish that step in Adobe, try connecting again.</p>
       <p><a href="/api/auth/frameio/connect">Try Again</a> · <a href="/media">Back to Media</a></p>`,
    );
  }

  if (error === 'invalid_scope') {
    return html(
      'Frame.io - Adobe Scope Configuration Error',
      `<p>Adobe rejected the permissions requested by this Frame.io connection.</p>
       <p>This usually means the configured OAuth scopes do not match the Adobe credential.</p>
       ${errorDesc ? `<pre>${errorDesc}</pre>` : ''}
       <p><a href="/media">Back to Media</a></p>`,
    );
  }

  return html(
    'Frame.io - Connection Failed',
    `<p>Adobe could not complete the Frame.io connection.</p>
     <p><strong>Error:</strong> ${error}${errorDesc ? ` (${errorDesc})` : ''}</p>
     <p><a href="/api/auth/frameio/connect">Try Again</a> · <a href="/media">Back to Media</a></p>`,
  );
}

function renderTokenExchangeError(status: number, body: string) {
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      jump?: string;
      error_description?: string;
    };

    if (parsed.error === 'ride_AdobeID_acct_actreq') {
      return html(
        'Frame.io - Adobe Account Action Required',
        `<p>Adobe needs you to complete a quick account step before Frame.io can finish connecting.</p>
         <p>This is usually something like a password update, security check, or terms confirmation on the Adobe side.</p>
         ${parsed.jump ? `<p><a href="${parsed.jump}">Continue in Adobe</a></p>` : ''}
         <p><a href="/api/auth/frameio/connect">Try Again</a> · <a href="/media">Back to Media</a></p>`,
      );
    }

    if (parsed.error === 'invalid_scope') {
      return html(
        'Frame.io - Adobe Scope Configuration Error',
        `<p>Adobe rejected the permissions requested by this Frame.io connection.</p>
         <p>This usually means the configured OAuth scopes do not match the Adobe credential.</p>
         ${parsed.error_description ? `<pre>${parsed.error_description}</pre>` : ''}
         <p><a href="/media">Back to Media</a></p>`,
      );
    }
  } catch {}

  return html(
    'Frame.io - Token Exchange Failed',
    `<p>Adobe IMS returned <strong>${status}</strong> while finishing the Frame.io connection.</p>
     <pre>${body}</pre>
     <p><a href="/api/auth/frameio/connect">Try Again</a> · <a href="/media">Back to Media</a></p>`,
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDesc = searchParams.get('error_description');

  if (error) {
    return renderOAuthError(error, errorDesc);
  }

  if (!code) {
    return html(
      'Frame.io - No Authorization Code',
      `<p>Adobe did not return an authorization code. Try connecting again.</p>
       <p><a href="/api/auth/frameio/connect">Try Again</a> · <a href="/media">Back to Media</a></p>`,
    );
  }

  const clientId = process.env.FRAMEIO_CLIENT_ID?.trim();
  const clientSecret = process.env.FRAMEIO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.FRAMEIO_REDIRECT_URI?.trim() ?? DEFAULT_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    return html(
      'Frame.io - Configuration Error',
      `<p>FRAMEIO_CLIENT_ID or FRAMEIO_CLIENT_SECRET is not set in .env.local.</p>`,
    );
  }

  const tokenRes = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    return renderTokenExchangeError(tokenRes.status, body);
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  if (!tokenData.access_token || !tokenData.refresh_token) {
    return html(
      'Frame.io - Unexpected Adobe Response',
      `<p>Adobe returned a response without the expected tokens.</p>
       <pre>${JSON.stringify(tokenData, null, 2)}</pre>`,
    );
  }

  storeTokens(tokenData);

  const base = new URL(req.url);
  return NextResponse.redirect(new URL('/media', base));
}
