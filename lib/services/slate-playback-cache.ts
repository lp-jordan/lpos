import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CACHE_DIR = path.join(os.tmpdir(), 'lpos-slate-playback-cache');
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedPlaybackFile {
  cacheKey: string;
  filePath: string;
  filename: string;
}

export async function cacheFtpPlaybackFile(
  host: string,
  remotePath: string,
  onProgress?: (received: number, total: number) => void,
): Promise<CachedPlaybackFile> {
  await ensureCacheDir();
  await cleanupExpiredCacheFiles();

  const filename = path.basename(remotePath);
  const ext = path.extname(filename) || '.mp4';
  const cacheKey = crypto.createHash('sha1').update(`${host}:${remotePath}`).digest('hex');
  const targetPath = path.join(CACHE_DIR, `${cacheKey}${ext}`);

  if (!fs.existsSync(targetPath)) {
    const client = new MinimalFtpDownloadClient(host, 21, { dataTimeoutMs: 5 * 60 * 1000 });
    try {
      await client.connectAnonymous();
      await client.download(remotePath, targetPath, onProgress);
    } finally {
      await client.close();
    }
  } else {
    const now = new Date();
    fs.utimesSync(targetPath, now, now);
  }

  return {
    cacheKey,
    filePath: targetPath,
    filename,
  };
}

export async function getCachedPlaybackFile(cacheKey: string): Promise<CachedPlaybackFile | null> {
  await ensureCacheDir();
  await cleanupExpiredCacheFiles();

  const matches = await fsp.readdir(CACHE_DIR);
  const filename = matches.find((entry) => entry.startsWith(`${cacheKey}.`) || entry === cacheKey);
  if (!filename) return null;

  return {
    cacheKey,
    filePath: path.join(CACHE_DIR, filename),
    filename,
  };
}

async function ensureCacheDir(): Promise<void> {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
}

async function cleanupExpiredCacheFiles(): Promise<void> {
  const entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const filePath = path.join(CACHE_DIR, entry.name);
    try {
      const stats = await fsp.stat(filePath);
      if (now - stats.mtimeMs > MAX_CACHE_AGE_MS) {
        await fsp.unlink(filePath);
      }
    } catch {
      // Ignore cache cleanup races.
    }
  }));
}

class MinimalFtpDownloadClient {
  private control: net.Socket | null = null;
  private buffer = '';
  private readonly controlTimeoutMs = 15000;
  private readonly dataTimeoutMs: number;
  private closing = false;
  private lastResponseCode = 0;

  constructor(
    private readonly host: string,
    private readonly port: number,
    options: { dataTimeoutMs?: number } = {},
  ) {
    this.dataTimeoutMs = options.dataTimeoutMs ?? 15000;
  }

  async connectAnonymous(): Promise<void> {
    this.closing = false;
    this.control = net.createConnection({ host: this.host, port: this.port });
    this.control.setEncoding('utf8');

    await this.readExpected([220]);
    await this.sendCommand('USER anonymous', [230, 331]);
    if (this.lastResponseCode === 331) {
      await this.sendCommand('PASS leaderslate@example.com', [230]);
    }
    await this.sendCommand('TYPE I', [200]);
  }

  async download(
    remotePath: string,
    outputPath: string,
    onProgress?: (received: number, total: number) => void,
  ): Promise<void> {
    let totalBytes = -1;
    try {
      const sizeResponse = await this.sendCommand(`SIZE ${normalizeFtpCommandPath(remotePath)}`, [213]);
      totalBytes = parseInt(sizeResponse.message.slice(4).trim(), 10);
    } catch {
      // SIZE not supported by this server — proceed without progress tracking.
    }

    const pasv = await this.sendCommand('PASV', [227]);
    const endpoint = parsePasvEndpoint(pasv.message);
    const dataSocket = net.createConnection(endpoint);
    const output = fs.createWriteStream(outputPath);

    const dataPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let receivedBytes = 0;
      const timeout = setTimeout(() => {
        cleanup();
        settled = true;
        reject(new Error(`FTP data connection timed out for ${this.host}:${this.port}`));
      }, this.dataTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        dataSocket.removeAllListeners();
        output.removeAllListeners();
        if (!dataSocket.destroyed) dataSocket.destroySoon();
        output.end();
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      dataSocket.on('data', (chunk: Buffer) => {
        output.write(chunk);
        if (onProgress && totalBytes > 0) {
          receivedBytes += chunk.length;
          onProgress(receivedBytes, totalBytes);
        }
      });
      dataSocket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') {
          finish();
          return;
        }
        fail(error);
      });
      dataSocket.on('close', () => finish());
      output.on('error', (error) => fail(error));
    });

    await this.sendCommand(`RETR ${normalizeFtpCommandPath(remotePath)}`, [125, 150]);
    // Use the data timeout for the 226 response — the server only sends it after the
    // full transfer completes, so it can take as long as the data download itself.
    await this.readExpected([226, 250], this.dataTimeoutMs);
    await dataPromise;
  }

  async close(): Promise<void> {
    if (!this.control) return;
    this.closing = true;
    try {
      await this.sendCommand('QUIT', [221]);
    } catch {
      // Ignore shutdown errors.
    } finally {
      this.control.removeAllListeners();
      if (!this.control.destroyed) this.control.destroySoon();
      this.control = null;
      this.buffer = '';
      this.lastResponseCode = 0;
      this.closing = false;
    }
  }

  private async sendCommand(command: string, expectedCodes: number[]): Promise<{ code: number; message: string }> {
    if (!this.control) throw new Error('FTP control connection is not established');
    this.control.write(`${command}\r\n`);
    return this.readExpected(expectedCodes);
  }

  private async readExpected(expectedCodes: number[], timeoutMs = this.controlTimeoutMs): Promise<{ code: number; message: string }> {
    if (!this.control) throw new Error('FTP control connection is not established');

    return new Promise((resolve, reject) => {
      const socket = this.control!;
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        settled = true;
        reject(new Error(`FTP control response timed out for ${this.host}:${this.port}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };

      const onError = (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!this.closing) {
          reject(new Error(`FTP connection closed for ${this.host}:${this.port}`));
        }
      };

      const tryResolve = () => {
        const lines = this.buffer.split(/\r?\n/);
        if (!this.buffer.endsWith('\n')) return;
        const responseLines = lines.filter(Boolean);
        if (responseLines.length === 0) return;
        const finalLine = responseLines[responseLines.length - 1];
        const code = Number(finalLine.slice(0, 3));
        if (!Number.isFinite(code) || finalLine[3] !== ' ') return;

        this.lastResponseCode = code;
        this.buffer = '';
        settled = true;
        cleanup();

        if (!expectedCodes.includes(code)) {
          reject(new Error(finalLine.slice(4).trim() || `FTP error ${code}`));
          return;
        }

        resolve({ code, message: finalLine });
      };

      const onData = (chunk: string) => {
        this.buffer += chunk;
        tryResolve();
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
      tryResolve();
    });
  }
}

function parsePasvEndpoint(message: string): { host: string; port: number } {
  const match = message.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!match) {
    throw new Error('FTP PASV response could not be parsed');
  }

  return {
    host: `${match[1]}.${match[2]}.${match[3]}.${match[4]}`,
    port: Number(match[5]) * 256 + Number(match[6]),
  };
}

function normalizeFtpCommandPath(remotePath: string): string {
  const trimmed = remotePath.trim();
  if (!trimmed) throw new Error('remotePath is required');
  return trimmed;
}
