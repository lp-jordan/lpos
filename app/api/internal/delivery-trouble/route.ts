/**
 * Internal endpoint — called by the lpos-ingest server when a delivery-link
 * recipient submits the "Having trouble?" form on the public download page.
 *
 * Auth: shared X-Api-Key (INGEST_API_KEY), same secret already used in the
 * dashboard → ingest direction. The ingest server holds it on Railway env.
 *
 * Body: full DeliveryTroublePayload (see delivery-notification-service.ts).
 *
 * Always returns 200 on auth/shape success — so the recipient gets a clean
 * "we got it" confirmation even if downstream (Slack lookup, DB write) had
 * trouble. Failures inside notifyDeliveryTrouble are logged, not propagated.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  notifyDeliveryTrouble,
  type DeliveryTroublePayload,
} from '@/lib/services/delivery-notification-service';

const INGEST_API_KEY = process.env.INGEST_API_KEY ?? '';

export async function POST(req: NextRequest) {
  // Auth — single shared secret with the ingest server
  if (!INGEST_API_KEY) {
    console.error('[delivery-trouble] INGEST_API_KEY not configured — refusing request');
    return NextResponse.json({ error: 'Service misconfigured' }, { status: 500 });
  }
  const apiKey = req.headers.get('x-api-key');
  if (apiKey !== INGEST_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Partial<DeliveryTroublePayload>;
  if (!body.deliveryToken || !body.projectName) {
    return NextResponse.json(
      { error: 'deliveryToken and projectName are required' },
      { status: 400 },
    );
  }

  // Best-effort delivery — log failures but always 200 to the ingest server
  try {
    await notifyDeliveryTrouble({
      deliveryToken:      body.deliveryToken,
      projectName:        body.projectName,
      clientName:         body.clientName         ?? null,
      label:              body.label              ?? null,
      description:        body.description        ?? null,
      queueSummary:       body.queueSummary       ?? null,
      userAgent:          body.userAgent          ?? null,
      createdByUserEmail: body.createdByUserEmail ?? null,
      projectId:          body.projectId          ?? null,
    });
  } catch (err) {
    console.error('[delivery-trouble] notifyDeliveryTrouble threw:', err);
  }

  return NextResponse.json({ ok: true });
}
