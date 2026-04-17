import { spawn, type ChildProcess } from 'node:child_process';
import type { AtemState } from './atem-utils';
import { resolveAtemBridgeCommand } from './runtime-dependencies';

interface BridgeCommand {
  command: string;
  args: string[];
  cwd?: string;
}

type LogFn = (...args: unknown[]) => void;

export class AtemBridgeClient {
  private port: number;
  private host: string;
  private log: LogFn;
  private helperProcess: ChildProcess | null = null;
  private helperReady = false;
  private helperStartingPromise: Promise<boolean> | null = null;
  private nextStartAttemptAt = 0;

  constructor(options: { port?: number; host?: string; log?: LogFn } = {}) {
    this.port = options.port ?? Number(process.env.ATEM_BRIDGE_PORT ?? 4011);
    this.host = options.host ?? '127.0.0.1';
    this.log = options.log ?? (() => {});
  }

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async ensureHelper(): Promise<boolean> {
    if (await this.isHealthy()) {
      if (!this.helperProcess) {
        // Orphaned bridge from a previous session — shut it down and start fresh.
        await this.shutdownOrphan();
      } else {
        this.helperReady = true;
        return true;
      }
    }
    if (this.helperStartingPromise) return this.helperStartingPromise;
    if (Date.now() < this.nextStartAttemptAt) return false;

    const command = this.resolveHelperCommand();
    if (!command) {
      this.log('ATEM bridge helper not found; continuing without helper');
      return false;
    }

    this.helperStartingPromise = this.startHelper(command);
    try {
      return await this.helperStartingPromise;
    } finally {
      this.helperStartingPromise = null;
    }
  }

  private async startHelper(command: BridgeCommand): Promise<boolean> {
    this.log('Starting ATEM bridge helper', command.command, command.args.join(' '));
    try {
      this.helperProcess = spawn(command.command, command.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(command.cwd ? { cwd: command.cwd } : {}),
      });
    } catch (error) {
      this.nextStartAttemptAt = Date.now() + 5000;
      this.log(`ATEM bridge helper could not be spawned: ${(error as Error).message}`);
      return false;
    }

    this.helperProcess.stdout?.on('data', (chunk: Buffer) => {
      this.log('[atem-bridge]', chunk.toString().trim());
    });
    this.helperProcess.stderr?.on('data', (chunk: Buffer) => {
      this.log('[atem-bridge:error]', chunk.toString().trim());
    });
    this.helperProcess.on('error', (error) => {
      this.helperReady = false;
      this.nextStartAttemptAt = Date.now() + 5000;
      this.log(`ATEM bridge helper process error: ${error.message}`);
    });
    this.helperProcess.on('exit', (code) => {
      this.helperReady = false;
      this.helperProcess = null;
      this.nextStartAttemptAt = Date.now() + 5000;
      this.log(`ATEM bridge helper exited with code ${code}`);
    });

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await this.isHealthy()) {
        this.helperReady = true;
        this.nextStartAttemptAt = 0;
        return true;
      }
    }

    this.nextStartAttemptAt = Date.now() + 5000;
    this.log('ATEM bridge helper failed to become healthy');
    return false;
  }

  private resolveHelperCommand(): BridgeCommand | null {
    return resolveAtemBridgeCommand();
  }

  private async shutdownOrphan(): Promise<void> {
    this.log('Found orphaned ATEM bridge — shutting it down');
    try {
      await fetch(`${this.baseUrl}/v1/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      await new Promise((r) => setTimeout(r, 400));
    } catch { /* already gone, that's fine */ }
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request<T = unknown>(pathname: string, options: RequestInit = {}): Promise<T> {
    const timeoutMs = pathname === '/v1/connect' ? 15000 : 5000;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        ...options,
      });
    } catch (error) {
      const e = error as Error;
      if (e.name === 'TimeoutError') throw new Error(`Bridge request timed out after ${timeoutMs}ms for ${pathname}`);
      throw error;
    }

    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const err = new Error((payload.error as string) ?? `Bridge request failed: ${response.status}`);
      throw err;
    }
    return payload as T;
  }

  getState(): Promise<AtemState>             { return this.request('/v1/state'); }
  connect(ip: string): Promise<void>         { return this.request('/v1/connect', { method: 'POST', body: JSON.stringify({ ipAddress: ip }) }); }
  disconnect(): Promise<void>                { return this.request('/v1/disconnect', { method: 'POST' }); }
  setPreviewInput(id: number): Promise<void> { return this.request('/v1/preview', { method: 'POST', body: JSON.stringify({ inputId: id }) }); }
  setProgramInput(id: number): Promise<void> { return this.request('/v1/program', { method: 'POST', body: JSON.stringify({ inputId: id }) }); }
  performCut(): Promise<void>                { return this.request('/v1/cut', { method: 'POST' }); }
  performAuto(): Promise<void>               { return this.request('/v1/auto', { method: 'POST' }); }
  setRecordingFilename(f: string): Promise<void> { return this.request('/v1/record/filename', { method: 'POST', body: JSON.stringify({ filename: f }) }); }
  startRecording(): Promise<void>            { return this.request('/v1/record/start', { method: 'POST' }); }
  stopRecording(): Promise<void>             { return this.request('/v1/record/stop', { method: 'POST' }); }
  setOutput4Mode(mode: string): Promise<void>{ return this.request('/v1/output4/mode', { method: 'POST', body: JSON.stringify({ mode }) }); }

  dispose(): void {
    if (this.helperProcess && !this.helperProcess.killed) {
      this.helperProcess.kill();
    }
  }
}
