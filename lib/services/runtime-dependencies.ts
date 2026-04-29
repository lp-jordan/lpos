import fs from 'node:fs';
import path from 'node:path';
import { resolveLibreOfficeBinary } from './presentation-service';

export interface RuntimeDependencyReport {
  id: string;
  label: string;
  configured: boolean;
  available: boolean;
  required: boolean;
  details: string;
  paths: string[];
}

export interface RuntimeReport {
  runtimeRoot: string;
  dependencies: RuntimeDependencyReport[];
}

const WHISPER_EXECUTABLE_NAMES = process.platform === 'win32'
  ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
  : ['whisper-cli', 'whisper', 'main'];

function existingPathOrNull(targetPath: string | null | undefined): string | null {
  const candidate = targetPath?.trim();
  if (!candidate) return null;
  return pathExists(candidate) ? candidate : null;
}

export function getRuntimeRoot(): string {
  return process.env.LPOS_RUNTIME_DIR?.trim() || path.join(process.cwd(), 'runtime');
}

export function getWhisperRuntimeDir(): string {
  const explicit = existingPathOrNull(process.env.LPOS_WHISPER_RUNTIME_DIR);
  if (explicit) return explicit;

  return path.join(getRuntimeRoot(), 'whisper-runtime');
}

export function getWhisperModelDir(): string {
  const explicit = existingPathOrNull(process.env.LPOS_WHISPER_MODEL_DIR);
  if (explicit) return explicit;

  const defaultDir = path.join(getRuntimeRoot(), 'whisper-models');
  if (pathExists(defaultDir)) return defaultDir;

  return process.env.LPOS_WHISPER_MODEL_DIR?.trim() || defaultDir;
}

export function getAtemBridgeDir(): string {
  return process.env.ATEM_BRIDGE_DIR?.trim() || path.join(getRuntimeRoot(), 'atem-bridge');
}

export function getStorageRoot(): string {
  return process.env.LPOS_STORAGE_ROOT?.trim() || path.join(process.cwd(), 'data');
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths.filter((value): value is string => Boolean(value)).map((value) => path.normalize(value)))];
}

function pathExists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

export function resolveWhisperBinaryPath(): string | null {
  const explicit = existingPathOrNull(process.env.LPOS_WHISPER_BINARY);
  if (explicit) return explicit;

  const runtimeDir = getWhisperRuntimeDir();
  for (const executableName of WHISPER_EXECUTABLE_NAMES) {
    const candidate = path.join(runtimeDir, executableName);
    if (pathExists(candidate)) return candidate;
  }

  return null;
}

export function resolveAtemBridgeCommand(): { command: string; args: string[]; cwd: string } | null {
  const bridgeDir = getAtemBridgeDir();
  const exePath = path.join(bridgeDir, 'atem-bridge.exe');
  if (pathExists(exePath)) return { command: exePath, args: [], cwd: bridgeDir };

  const scriptPath = path.join(bridgeDir, 'atem-bridge.js');
  if (pathExists(scriptPath)) return { command: process.execPath, args: [scriptPath], cwd: bridgeDir };

  return null;
}

export function getRuntimeDependencyReport(): RuntimeReport {
  const whisperBinary = resolveWhisperBinaryPath();
  const whisperModelDir = getWhisperModelDir();
  const atemBridgeDir = getAtemBridgeDir();
  const atemCommand = resolveAtemBridgeCommand();
  const storageRoot = getStorageRoot();
  const libreofficeBinary = resolveLibreOfficeBinary();

  const whisperBinaryPaths = uniquePaths([
    process.env.LPOS_WHISPER_BINARY?.trim(),
    ...WHISPER_EXECUTABLE_NAMES.map((name) => path.join(getWhisperRuntimeDir(), name)),
  ]);
  const atemPaths = uniquePaths([
    process.env.ATEM_BRIDGE_DIR?.trim(),
    path.join(atemBridgeDir, 'atem-bridge.exe'),
    path.join(atemBridgeDir, 'atem-bridge.js'),
  ]);

  return {
    runtimeRoot: getRuntimeRoot(),
    dependencies: [
      {
        id: 'whisper-runtime',
        label: 'Whisper Runtime',
        configured: Boolean(process.env.LPOS_WHISPER_BINARY?.trim() || pathExists(getWhisperRuntimeDir())),
        available: Boolean(whisperBinary && pathExists(whisperBinary)),
        required: true,
        details: whisperBinary
          ? `Using ${whisperBinary}`
          : 'Missing Whisper executable. Provide LPOS_WHISPER_BINARY or stage files into runtime/whisper-runtime.',
        paths: whisperBinaryPaths,
      },
      {
        id: 'whisper-models',
        label: 'Whisper Models',
        configured: Boolean(process.env.LPOS_WHISPER_MODEL_DIR?.trim() || pathExists(whisperModelDir)),
        available: pathExists(whisperModelDir),
        required: true,
        details: pathExists(whisperModelDir)
          ? `Using ${whisperModelDir}`
          : 'Missing Whisper model directory. Provide LPOS_WHISPER_MODEL_DIR or stage files into runtime/whisper-models.',
        paths: uniquePaths([whisperModelDir]),
      },
      {
        id: 'atem-bridge',
        label: 'ATEM Bridge Helper',
        configured: Boolean(process.env.ATEM_BRIDGE_DIR?.trim() || pathExists(atemBridgeDir)),
        available: Boolean(atemCommand),
        required: false,
        details: atemCommand
          ? `Using ${atemCommand.command}`
          : 'Helper not staged. Provide ATEM_BRIDGE_DIR or stage files into runtime/atem-bridge.',
        paths: atemPaths,
      },
      {
        id: 'storage-root',
        label: 'Storage Root',
        configured: true,
        available: pathExists(storageRoot),
        required: true,
        details: pathExists(storageRoot)
          ? `Using ${storageRoot}`
          : `Storage root does not exist yet: ${storageRoot}`,
        paths: uniquePaths([storageRoot]),
      },
      {
        id: 'libreoffice',
        label: 'LibreOffice',
        configured: Boolean(libreofficeBinary),
        available: Boolean(libreofficeBinary && (process.platform !== 'win32' || pathExists(libreofficeBinary))),
        required: false,
        details: libreofficeBinary
          ? `Using ${libreofficeBinary}`
          : 'LibreOffice not found. Install LibreOffice to enable PPTX → slide conversion for the Presentation tab.',
        paths: libreofficeBinary ? uniquePaths([libreofficeBinary]) : [],
      },
      {
        id: 'frameio',
        label: 'Frame.io Credentials',
        configured: Boolean(process.env.FRAMEIO_CLIENT_ID || process.env.FRAMEIO_API_TOKEN),
        available: Boolean(process.env.FRAMEIO_CLIENT_ID || process.env.FRAMEIO_API_TOKEN),
        required: false,
        details: process.env.FRAMEIO_CLIENT_ID || process.env.FRAMEIO_API_TOKEN
          ? 'Frame.io credentials detected.'
          : 'Frame.io credentials are external. Configure them explicitly before publish flows.',
        paths: [],
      },
      {
        id: 'cloudflare',
        label: 'Cloudflare Stream Credentials',
        configured: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_STREAM_TOKEN),
        available: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_STREAM_TOKEN),
        required: false,
        details: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_STREAM_TOKEN
          ? 'Cloudflare credentials detected.'
          : 'Cloudflare credentials are external. Configure them explicitly before stream publish flows.',
        paths: [],
      },
      {
        id: 'sardius',
        label: 'Sardius FTP Credentials',
        configured: Boolean(process.env.SARDIUS_FTP_HOST && process.env.SARDIUS_FTP_USER && process.env.SARDIUS_FTP_PASS),
        available: Boolean(process.env.SARDIUS_FTP_HOST && process.env.SARDIUS_FTP_USER && process.env.SARDIUS_FTP_PASS),
        required: false,
        details: (process.env.SARDIUS_FTP_HOST && process.env.SARDIUS_FTP_USER && process.env.SARDIUS_FTP_PASS)
          ? `Sardius FTP configured for ${process.env.SARDIUS_FTP_HOST}.`
          : 'Sardius FTP credentials not set. Add SARDIUS_FTP_HOST, SARDIUS_FTP_USER, SARDIUS_FTP_PASS to your environment.',
        paths: [],
      },
    ],
  };
}
