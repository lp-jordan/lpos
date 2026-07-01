import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  getSetting,
  setSetting,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  TRANSCRIPTION_MODEL_OPTIONS,
} from '@/lib/store/lpos-settings-store';
import { getWhisperModelDir } from '@/lib/services/runtime-dependencies';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Admin API for the whisper.cpp transcription knobs (model, workers, timeout).
 * Credentials stay in Doppler; these operational knobs live in `lpos_settings`
 * so an admin can retune without a redeploy.
 */

const ALLOWED_MODELS = new Set<string>(TRANSCRIPTION_MODEL_OPTIONS.map((o) => o.value));

function readConfig() {
  const modelDir = getWhisperModelDir();
  const options = TRANSCRIPTION_MODEL_OPTIONS.map((o) => {
    let installed = false;
    try {
      installed = fs.existsSync(path.join(modelDir, `ggml-${o.value}.bin`));
    } catch { /* modelDir may not exist yet */ }
    return { ...o, installed };
  });

  return {
    model: getSetting<string>(
      SETTING_KEYS.TRANSCRIPTION_MODEL,
      SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_MODEL],
    ),
    workers: getSetting<number>(
      SETTING_KEYS.TRANSCRIPTION_WORKERS,
      SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_WORKERS],
    ),
    timeoutMinutes: getSetting<number>(
      SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES,
      SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES],
    ),
    timeoutLengthAware: getSetting<boolean>(
      SETTING_KEYS.TRANSCRIPTION_TIMEOUT_LENGTH_AWARE,
      SETTING_DEFAULTS[SETTING_KEYS.TRANSCRIPTION_TIMEOUT_LENGTH_AWARE],
    ),
    modelDir,
    options,
  };
}

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;
  return NextResponse.json({ config: readConfig() });
}

export async function PUT(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  let body: {
    model?: unknown;
    workers?: unknown;
    timeoutMinutes?: unknown;
    timeoutLengthAware?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.model === 'string') {
    if (!ALLOWED_MODELS.has(body.model)) {
      return NextResponse.json({ error: `Unsupported model: ${body.model}` }, { status: 400 });
    }
    setSetting<string>(SETTING_KEYS.TRANSCRIPTION_MODEL, body.model);
  }

  if (typeof body.workers === 'number' && Number.isFinite(body.workers)) {
    const n = Math.min(8, Math.max(1, Math.floor(body.workers)));
    setSetting<number>(SETTING_KEYS.TRANSCRIPTION_WORKERS, n);
  }

  if (typeof body.timeoutMinutes === 'number' && Number.isFinite(body.timeoutMinutes)) {
    const n = Math.min(360, Math.max(1, Math.floor(body.timeoutMinutes)));
    setSetting<number>(SETTING_KEYS.TRANSCRIPTION_TIMEOUT_MINUTES, n);
  }

  if (typeof body.timeoutLengthAware === 'boolean') {
    setSetting<boolean>(SETTING_KEYS.TRANSCRIPTION_TIMEOUT_LENGTH_AWARE, body.timeoutLengthAware);
  }

  return NextResponse.json({ config: readConfig() });
}
