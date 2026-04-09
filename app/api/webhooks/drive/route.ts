/**
 * Google Drive push notification webhook
 *
 * Drive sends an HTTP POST here whenever something changes in a watched
 * resource. Importantly, these are *nudges* — the request body is empty.
 * The real change data is fetched via changes.list using our stored page token.
 *
 * Verification: Drive echoes back the token we set when registering the watch
 * channel. We reject any request that doesn't carry the expected token.
 *
 * Headers Drive sends:
 *   X-Goog-Channel-ID      — our channel ID
 *   X-Goog-Channel-Token   — our verification token
 *   X-Goog-Resource-State  — 'sync' (initial handshake) | 'change' | 'update' etc.
 *   X-Goog-Resource-ID     — resource being watched
 *   X-Goog-Message-Number  — monotonically increasing per channel
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveWatcherService } from '@/lib/services/container';

export async function POST(req: NextRequest) {
  const channelId     = req.headers.get('x-goog-channel-id') ?? '?';
  const resourceState = req.headers.get('x-goog-resource-state') ?? '?';
  const msgNumber     = req.headers.get('x-goog-message-number') ?? '?';

  console.log(`[webhooks/drive] nudge received — state=${resourceState} msg=${msgNumber} channel=${channelId}`);

  const expectedToken = process.env.GOOGLE_DRIVE_WEBHOOK_TOKEN?.trim();
  if (!expectedToken) {
    console.error('[webhooks/drive] GOOGLE_DRIVE_WEBHOOK_TOKEN not set');
    return NextResponse.json({ error: 'Drive webhook not configured' }, { status: 500 });
  }

  // Verify token
  const receivedToken = req.headers.get('x-goog-channel-token') ?? '';
  if (receivedToken !== expectedToken) {
    console.warn(`[webhooks/drive] token mismatch — received="${receivedToken}" expected="${expectedToken}"`);
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  // Initial sync handshake — Drive sends this when a channel is first registered.
  if (resourceState === 'sync') {
    console.log('[webhooks/drive] sync handshake acknowledged');
    return NextResponse.json({ ok: true });
  }

  // Kick off change processing in background — respond immediately so Drive
  // doesn't retry thinking we timed out.
  const watcher = getDriveWatcherService();
  if (watcher) {
    void watcher.processIncomingChanges().catch((err) => {
      console.error('[webhooks/drive] error processing changes:', err);
    });
  } else {
    console.warn('[webhooks/drive] watcher service not available');
  }

  return NextResponse.json({ ok: true });
}
