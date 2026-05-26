/**
 * Internal endpoint — called by the lpos-ingest server when the hourly sweep
 * marks a delivery link as expired and deletes its R2 files.
 *
 * Auth: shared X-Api-Key (INGEST_API_KEY).
 * Always returns 200 on auth/shape success so the ingest server gets a clean
 * response even if downstream notification logic fails.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  notifyDeliveryExpired,
  type DeliveryExpiredPayload,
} from '@/lib/services/delivery-notification-service';

const INGEST_API_KEY = process.env.INGEST_API_KEY ?? '';

export async function POST(req: NextRequest) {
  if (!INGEST_API_KEY) {
    console.error('[delivery-expired] INGEST_API_KEY not configured — refusing request');
    return NextResponse.json({ error: 'Service misconfigured' }, { status: 500 });
  }
  if (req.headers.get('x-api-key') !== INGEST_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Partial<DeliveryExpiredPayload>;
  if (!body.deliveryToken || !body.projectName) {
    return NextResponse.json(
      { error: 'deliveryToken and projectName are required' },
      { status: 400 },
    );
  }

  try {
    await notifyDeliveryExpired({
      deliveryToken:      body.deliveryToken,
      projectName:        body.projectName,
      clientName:         body.clientName         ?? null,
      label:              body.label              ?? null,
      createdByUserEmail: body.createdByUserEmail ?? null,
      projectId:          body.projectId          ?? null,
    });
  } catch (err) {
    console.error('[delivery-expired] notifyDeliveryExpired threw:', err);
  }

  return NextResponse.json({ ok: true });
}
