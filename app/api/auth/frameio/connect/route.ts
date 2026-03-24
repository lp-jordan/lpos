/**
 * GET /api/auth/frameio/connect
 *
 * Redirects the browser to Adobe IMS to start the OAuth 2.0
 * authorization_code flow for Frame.io V4.
 *
 * Prerequisites (set in .env.local):
 *   FRAMEIO_CLIENT_ID      — from Adobe Developer Console
 *   FRAMEIO_CLIENT_SECRET  — from Adobe Developer Console
 *   FRAMEIO_REDIRECT_URI   — https://localhost:3000/api/auth/frameio/callback
 *   FRAMEIO_SCOPES         — space-separated, from the Console credential page
 */

import { NextResponse } from 'next/server';

const IMS_AUTHORIZE = 'https://ims-na1.adobelogin.com/ims/authorize/v2';

export async function GET() {
  const clientId    = process.env.FRAMEIO_CLIENT_ID?.trim();
  const redirectUri = process.env.FRAMEIO_REDIRECT_URI?.trim()
    ?? 'https://localhost:3000/api/auth/frameio/callback';
  const scopes = process.env.FRAMEIO_SCOPES?.trim()
    ?? 'openid AdobeID offline_access';

  if (!clientId) {
    return NextResponse.json(
      { error: 'FRAMEIO_CLIENT_ID is not set in .env.local' },
      { status: 500 },
    );
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         scopes,
  });

  return NextResponse.redirect(`${IMS_AUTHORIZE}?${params.toString()}`);
}
