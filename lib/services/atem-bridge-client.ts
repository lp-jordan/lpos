import { spawn, execFile, type ChildProcess } from 'node:child_process';
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
  private nextStartAttemptAt = 0;
  // Serialises the entire ensureHelper() body so concurrent refreshAtemState()
  // ticks never race — only one spawn attempt can run at a time.
  private ensureHelperLock: Promise<boolean> | null = null;
  private remoteUrl: string | null = null;

  constructor(options: { port?: number; host?: string; log?: LogFn } = {}) {
    this.port = options.port ?? Number(process.env.ATEM_BRIDGE_PORT ?? 4011);
    this.host = options.host ?? '127.0.0.1';
    this.log = options.log ?? (() => {});
  }

  get isRemote(): boolean { return this.remoteUrl !== null; }

  private get baseUrl(): string {
    return this.remoteUrl ?? `http://${this.host}:${this.port}`;
  }

  async ensureHelper(): Promise<boolean> {
    if (this.ensureHelperLock) return this.ensureHelperLock;
    const work = this._ensureHelper();
    this.ensureHelperLock = work;
    try {
      return await work;
    } finally {
      if (this.ensureHelperLock === work) this.ensureHelperLock = null;
    }
  }

  private async _ensureHelper(): Promise<boolean> {
    // Remote mode: don't spawn anything locally, just check remote health.
    if (this.remoteUrl !== null) {
      const healthy = await this.isHealthy();
      this.helperReady = healthy;
      return healthy;
    }

    // Fast path: process we own is still running — trust it without an HTTP round-trip.
    // isHealthy() is only used during startHelper warmup and remote-mode checks.
    if (this.helperProcess !== null && this.helperProcess.exitCode === null && !this.helperProcess.killed) {
      this.helperReady = true;
      return true;
    }

    // Cooldown: don't retry too soon after a failed spawn attempt.
    if (Date.now() < this.nextStartAttemptAt) return false;

    // OS-level sweep: kill every atem-bridge.js process (ours or any orphan)
    // before spawning a fresh one. This replaces the old HTTP-based orphan
    // detection which had timing races (shutdown request landing on the new
    // bridge instead of the old one).
    await this.killAllBridgeProcesses();

    const command = this.resolveHelperCommand();
    if (!command) {
      this.log('ATEM bridge helper not found; continuing without helper');
      return false;
    }

    return this.startHelper(command);
  }

  // Kill every process that could block a fresh bridge from starting.
  // Uses two sources so nothing slips through:
  //   • pgrep -f 'atem-bridge.js'  — catches the bridge and any threadedclass
  //                                   workers whose argv includes the script path
  //   • lsof -iTCP:<port> LISTEN   — catches whatever is currently holding the
  //                                   port, regardless of process name
  // Escalates from SIGTERM → SIGKILL after 1.2 s (threadedclass workers often
  // ignore SIGTERM; no point waiting 6 s for something that never responds).
  private async killAllBridgeProcesses(): Promise<void> {
    const getPids = (): Promise<number[]> => new Promise(resolve => {
      execFile('pgrep', ['-f', 'atem-bridge.js'], (_err, pgrepOut) => {
        const byName = (pgrepOut?.trim() ?? '').split('\n')
          .map(s => parseInt(s.trim(), 10))
          .filter(n => Number.isFinite(n) && n > 0 && n !== process.pid);

        execFile('lsof', ['-n', `-iTCP:${this.port}`, '-sTCP:LISTEN', '-t'], (_err2, lsofOut) => {
          const byPort = (lsofOut?.trim() ?? '').split('\n')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isFinite(n) && n > 0 && n !== process.pid);

          resolve([...new Set([...byName, ...byPort])]);
        });
      });
    });

    const initial = await getPids();
    if (!initial.length) return;

    this.log(`[atem-bridge] sweeping ${initial.length} bridge process(es): ${initial.join(', ')}`);
    initial.forEach(pid => { try { process.kill(pid, 'SIGTERM'); } catch {} });

    // Poll until confirmed clear. Escalate to SIGKILL at 1.2 s.
    // Throw if something survives SIGKILL — don't spawn a new bridge into an
    // occupied port.
    let elapsed = 0;
    let sigkilled = false;

    while (true) {
      await new Promise(r => setTimeout(r, 300));
      const alive = await getPids();
      if (!alive.length) return;

      elapsed += 300;

      if (elapsed >= 1200 && !sigkilled) {
        sigkilled = true;
        this.log('[atem-bridge] process(es) did not exit after SIGTERM — sending SIGKILL');
        alive.forEach(pid => { try { process.kill(pid, 'SIGKILL'); } catch {} });
      }

      if (sigkilled && elapsed >= 10_000) {
        throw new Error(`[atem-bridge] port ${this.port} not cleared after ${elapsed}ms — cannot spawn bridge`);
      }
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

  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request<T = unknown>(pathname: string, options: RequestInit = {}): Promise<T> {
    const timeoutMs = pathname === '/v1/connect' ? 35000 : 5000;
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

  async enableRemote(url: string): Promise<void> {
    // Wait for any in-progress ensureHelper to settle before tearing down.
    if (this.ensureHelperLock) await this.ensureHelperLock.catch(() => {});
    await this.dispose();
    this.remoteUrl = url;
    this.helperReady = false;
  }

  disableRemote(): void {
    this.remoteUrl = null;
    this.helperReady = false;
    this.helperProcess = null;
    this.nextStartAttemptAt = 0; // allow immediate local respawn
  }

  async dispose(): Promise<void> {
    // SIGTERM the process we own so the ATEM session is released cleanly.
    if (this.helperProcess && !this.helperProcess.killed) {
      const proc = this.helperProcess;
      const exited = new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        setTimeout(resolve, 5000); // safety timeout
      });
      proc.kill('SIGTERM');
      await exited;
    }
    // Belt-and-suspenders: sweep any survivors (threadedclass workers or bridges
    // that died before helperProcess was set — i.e. the process we didn't own).
    await this.killAllBridgeProcesses();
  }
}
