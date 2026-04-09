/**
 * Admin — Google Drive setup & status
 *
 * POST /api/admin/drive/setup
 *   One-time bootstrap: creates the LPOS folder tree in the Shared Drive
 *   and registers the push notification webhook channel.
 *   Safe to re-run — all operations are idempotent.
 *
 * GET /api/admin/drive/status
 *   Returns connection health, channel expiry, and folder IDs.
 *
 * Both routes require admin role.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import { getDriveWatcherService } from '@/lib/services/container';
import { ensureLposRootFolder } from '@/lib/services/drive-folder-service';
import { getActiveChannel } from '@/lib/store/drive-sync-db';

// ── POST /api/admin/drive/setup ───────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authError = await requireRole(req, 'admin');
  if (authError) return authError;

  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();
  if (!driveId) {
    return NextResponse.json(
      { error: 'GOOGLE_DRIVE_SHARED_DRIVE_ID is not set in environment' },
      { status: 500 },
    );
  }

  try {
    // Ensure folder tree
    const rootFolderId = await ensureLposRootFolder(driveId);

    // Ensure watch channel (force=true replaces the channel even if still valid)
    const watcher = getDriveWatcherService();
    if (!watcher) {
      return NextResponse.json(
        { error: 'DriveWatcherService is not running — check env vars and restart server' },
        { status: 500 },
      );
    }

    const force = new URL(req.url).searchParams.get('force') === 'true';
    if (force) {
      await watcher.forceRenewChannel();
    } else {
      await watcher.ensureWatchChannel();
    }

    const channel = getActiveChannel(driveId);

    return NextResponse.json({
      ok: true,
      rootFolderId,
      channel: channel
        ? { channelId: channel.channelId, expiresAt: channel.expiresAt }
        : null,
    });
  } catch (err) {
    console.error('[admin/drive/setup] error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ── GET /api/admin/drive/status ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authError = await requireRole(req, 'admin');
  if (authError) return authError;

  const driveId = process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID?.trim();

  const watcher = getDriveWatcherService();
  const status  = watcher?.getStatus() ?? { active: false, channelExpiresAt: null };
  const channel = driveId ? getActiveChannel(driveId) : null;

  return NextResponse.json({
    configured:       !!driveId,
    driveId:          driveId ?? null,
    webhookUrl:       process.env.GOOGLE_DRIVE_WEBHOOK_URL ?? null,
    webhookTokenSet:  !!process.env.GOOGLE_DRIVE_WEBHOOK_TOKEN?.trim(),
    ...status,
    channel: channel
      ? { channelId: channel.channelId, expiresAt: channel.expiresAt }
      : null,
  });
}
