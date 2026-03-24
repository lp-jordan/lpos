import { NextRequest, NextResponse } from 'next/server';
import { getClearedStorageAdminCookie, getStorageAdminCookie, hashPin, verifyPin } from '@/lib/services/storage-auth';
import { patchStorageConfig, readStorageConfig } from '@/lib/store/storage-config-store';

function normalizePin(pin: unknown): string {
  return typeof pin === 'string' ? pin.trim() : '';
}

function pinError(pin: string): string | null {
  if (!/^\d{4,12}$/.test(pin)) return 'PIN must be 4-12 digits.';
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { pin?: string; mode?: 'unlock' | 'bootstrap' };
  const pin = normalizePin(body.pin);
  const mode = body.mode ?? 'unlock';
  const config = readStorageConfig();

  if (mode === 'bootstrap') {
    if (config.adminPinHash) {
      return NextResponse.json({ error: 'Admin PIN is already configured.' }, { status: 409 });
    }
    const validation = pinError(pin);
    if (validation) return NextResponse.json({ error: validation }, { status: 400 });

    patchStorageConfig({ adminPinHash: hashPin(pin) });
    const response = NextResponse.json({ ok: true, bootstrapped: true, unlocked: true });
    const cookie = getStorageAdminCookie();
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    return response;
  }

  if (!config.adminPinHash) {
    return NextResponse.json({ error: 'Admin PIN is not configured yet.' }, { status: 409 });
  }

  if (!verifyPin(pin, config.adminPinHash)) {
    return NextResponse.json({ error: 'Incorrect admin PIN.' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, unlocked: true });
  const cookie = getStorageAdminCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true, unlocked: false });
  const cookie = getClearedStorageAdminCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
