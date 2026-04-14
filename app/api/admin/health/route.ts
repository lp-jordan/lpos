/**
 * GET /api/admin/health
 *
 * Returns a structured health report for all runtime dependencies and
 * SQLite databases. Always responds with HTTP 200 so load-balancers and
 * monitoring tools can read the body regardless of degradation status.
 * Requires admin role.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/services/api-auth';
import {
  resolveWhisperBinaryPath,
  getWhisperModelDir,
} from '@/lib/services/runtime-dependencies';
import { resolveLibreOfficeBinary } from '@/lib/services/presentation-service';
import { getStorageAllocationDecision } from '@/lib/services/storage-volume-service';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CheckResult {
  ok:     boolean;
  detail: string;
}

interface HealthResponse {
  status:    'ok' | 'degraded';
  checks: {
    whisper_binary:  CheckResult;
    whisper_models:  CheckResult;
    libreoffice:     CheckResult;
    databases:       CheckResult;
    storage_volumes: CheckResult;
  };
  timestamp: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkWhisperBinary(): CheckResult {
  const binary = resolveWhisperBinaryPath();
  if (!binary) {
    return { ok: false, detail: 'Whisper binary not found. Set LPOS_WHISPER_BINARY or stage into runtime/whisper-runtime.' };
  }
  if (!fs.existsSync(binary)) {
    return { ok: false, detail: `Whisper binary path resolved but file missing: ${binary}` };
  }
  return { ok: true, detail: `Found: ${binary}` };
}

function checkWhisperModels(): CheckResult {
  const modelDir = getWhisperModelDir();
  if (!fs.existsSync(modelDir)) {
    return { ok: false, detail: `Model directory not found: ${modelDir}` };
  }
  let binFiles: string[] = [];
  try {
    binFiles = fs.readdirSync(modelDir).filter((f) => f.endsWith('.bin'));
  } catch (err) {
    return { ok: false, detail: `Could not read model directory: ${(err as Error).message}` };
  }
  if (binFiles.length === 0) {
    return { ok: false, detail: `Model directory exists but contains no .bin files: ${modelDir}` };
  }
  return { ok: true, detail: `${binFiles.length} model(s) in ${modelDir}` };
}

function checkLibreOffice(): CheckResult {
  const binary = resolveLibreOfficeBinary();
  if (!binary) {
    return { ok: false, detail: 'LibreOffice not found. Install LibreOffice to enable PPTX conversion.' };
  }
  if (process.platform === 'win32' && !fs.existsSync(binary)) {
    return { ok: false, detail: `LibreOffice path resolved but binary missing: ${binary}` };
  }
  return { ok: true, detail: `Found: ${binary}` };
}

function checkStorageVolumes(): CheckResult {
  const { active, volumes } = getStorageAllocationDecision();
  if (!active) {
    const enabledCount = volumes.filter((v) => v.enabled).length;
    return {
      ok: false,
      detail: enabledCount > 0
        ? `${enabledCount} volume(s) configured but none eligible — check drive availability, free space, and threshold settings`
        : 'No storage volumes configured. Add a volume in Storage Settings.',
    };
  }
  const eligibleCount = volumes.filter((v) => v.eligible).length;
  return { ok: true, detail: `Active: ${active.rootPath} — ${eligibleCount} eligible volume(s)` };
}

function checkDatabases(): CheckResult {
  const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

  const dbFiles = [
    'lpos-core.sqlite',
    'lpos-ingest-queue.sqlite',
    'lpos-activity.sqlite',
    'lpos-drive-sync.sqlite',
    'lpos-canonical-assets.sqlite',
  ];

  const failures: string[] = [];

  for (const filename of dbFiles) {
    const dbPath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(dbPath)) {
      // Not all DBs exist on every deployment — skip missing ones
      continue;
    }
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      db.prepare('SELECT 1').get();
      db.close();
    } catch (err) {
      failures.push(`${filename}: ${(err as Error).message}`);
    }
  }

  if (failures.length > 0) {
    return { ok: false, detail: `DB errors: ${failures.join('; ')}` };
  }
  return { ok: true, detail: 'All reachable databases responded to SELECT 1' };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const deny = await requireRole(req, 'admin');
  if (deny) return deny;

  const whisper_binary  = checkWhisperBinary();
  const whisper_models  = checkWhisperModels();
  const libreoffice     = checkLibreOffice();
  const databases       = checkDatabases();
  const storage_volumes = checkStorageVolumes();

  const allOk = whisper_binary.ok && whisper_models.ok && libreoffice.ok && databases.ok && storage_volumes.ok;

  const body: HealthResponse = {
    status:    allOk ? 'ok' : 'degraded',
    checks:    { whisper_binary, whisper_models, libreoffice, databases, storage_volumes },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: 200 });
}
