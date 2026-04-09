/**
 * ScriptsRegistry
 *
 * Per-project flat JSON store for script assets.
 * Registry file:  data/projects/{projectId}/scripts-registry.json
 * Script files:   data/projects/{projectId}/scripts/{scriptId}{ext}
 * Extracted text: data/projects/{projectId}/scripts/{scriptId}.extracted.txt
 *
 * Pure functions — no class, no singleton.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScriptAsset, ScriptStatus } from '@/lib/models/script-asset';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

export function scriptsDir(projectId: string): string {
  return path.join(DATA_DIR, 'projects', projectId, 'scripts');
}

function registryPath(projectId: string): string {
  return path.join(DATA_DIR, 'projects', projectId, 'scripts-registry.json');
}

function extractedPath(projectId: string, scriptId: string): string {
  return path.join(scriptsDir(projectId), `${scriptId}.extracted.txt`);
}

// ── Read / write ──────────────────────────────────────────────────────────────

export function readScriptsRegistry(projectId: string): ScriptAsset[] {
  const p = registryPath(projectId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ScriptAsset[];
  } catch {
    return [];
  }
}

export function writeScriptsRegistry(projectId: string, scripts: ScriptAsset[]): void {
  const p = registryPath(projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(scripts, null, 2));
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export interface RegisterScriptInput {
  projectId:        string;
  name?:            string;
  originalFilename: string;
  filePath:         string;
  fileSize:         number | null;
  mimeType?:        string;
}

export function registerScript(input: RegisterScriptInput): ScriptAsset {
  const scripts = readScriptsRegistry(input.projectId);
  const now     = new Date().toISOString();

  const script: ScriptAsset = {
    scriptId:         randomUUID(),
    projectId:        input.projectId,
    name:             input.name ?? input.originalFilename,
    originalFilename: input.originalFilename,
    filePath:         input.filePath,
    fileSize:         input.fileSize,
    mimeType:         input.mimeType ?? guessMime(input.originalFilename),
    status:           'uploaded',
    hasExtractedText: false,
    uploadedAt:       now,
    updatedAt:        now,
  };

  scripts.push(script);
  writeScriptsRegistry(input.projectId, scripts);
  return script;
}

export function getScript(projectId: string, scriptId: string): ScriptAsset | null {
  return readScriptsRegistry(projectId).find((s) => s.scriptId === scriptId) ?? null;
}

export interface ScriptPatch {
  name?:             string;
  filePath?:         string;
  fileSize?:         number | null;
  status?:           ScriptStatus;
  hasExtractedText?: boolean;
  driveFileId?:      string;
  driveWebViewUrl?:  string;
  driveSource?:      boolean;
}

export function patchScript(projectId: string, scriptId: string, patch: ScriptPatch): ScriptAsset | null {
  const scripts = readScriptsRegistry(projectId);
  const idx     = scripts.findIndex((s) => s.scriptId === scriptId);
  if (idx === -1) return null;

  scripts[idx] = {
    ...scripts[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  writeScriptsRegistry(projectId, scripts);
  return scripts[idx];
}

export function removeScript(projectId: string, scriptId: string): ScriptAsset | null {
  const scripts = readScriptsRegistry(projectId);
  const idx     = scripts.findIndex((s) => s.scriptId === scriptId);
  if (idx === -1) return null;
  const [removed] = scripts.splice(idx, 1);
  writeScriptsRegistry(projectId, scripts);
  return removed;
}

// ── Extracted text helpers ────────────────────────────────────────────────────

export function getExtractedText(projectId: string, scriptId: string): string | null {
  const p = extractedPath(projectId, scriptId);
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function saveExtractedText(projectId: string, scriptId: string, text: string): void {
  const p = extractedPath(projectId, scriptId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf':  'application/pdf',
    '.txt':  'text/plain',
    '.doc':  'application/msword',
  };
  return map[ext] ?? 'application/octet-stream';
}
