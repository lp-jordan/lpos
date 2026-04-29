import net from 'node:net';
import { SerialTaskQueue } from './serial-task-queue';

export interface CqMixerState {
  connected: boolean;
  ip: string;
  name: string;
  lastError: string;
  busy: boolean;
  recording: boolean;
  trackMutes: boolean[];
  trackArmed: boolean[];
  trackGains: number[];
}

export function createDefaultCqMixerState(ip = ''): CqMixerState {
  return {
    connected: false, ip, name: '', lastError: '', busy: false, recording: false,
    trackMutes: Array(8).fill(false),
    trackArmed: Array(8).fill(false),
    trackGains: Array(8).fill(0),
  };
}

const HANDSHAKE = Buffer.from([0x7f, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]);
const CMD_START = Buffer.from([0xf7, 0x08, 0x11, 0x11, 0x03, 0xff, 0x00, 0x00]);
const CMD_STOP = Buffer.from([0xf7, 0x08, 0x11, 0x11, 0x01, 0xff, 0x00, 0x00]);
const PORT = 51326;
const CONNECT_TIMEOUT_MS = 4000;
const PROBE_INTERVAL_MS = 5000;
const COMMAND_COOLDOWN_MS = 5000;
// Hard ceiling: if busy hasn't cleared after this long, force-reset it.
const BUSY_RESET_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CqMixerClient {
  private probeTimer: NodeJS.Timeout | null = null;
  private busyResetTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private queue = new SerialTaskQueue();
  private currentState: CqMixerState;
  private pendingCommands = 0;
  private armBitmask = 0;

  constructor(
    private readonly ip: string,
    private readonly onStateChange: (state: CqMixerState) => void,
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.currentState = createDefaultCqMixerState(ip);
  }

  start(): void {
    this.scheduleProbe(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    if (this.busyResetTimer) { clearTimeout(this.busyResetTimer); this.busyResetTimer = null; }
  }

  startRecording(): void {
    this.pendingCommands++;
    this.setState({ busy: true, recording: true });
    this.armBusyReset();
    this.queue.enqueue(async () => {
      await this.doRequest(CMD_START);
      await sleep(COMMAND_COOLDOWN_MS);
    }).catch((err) =>
      this.log('[cq-mixer] startRecording failed', (err as Error).message)
    ).finally(() => {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      if (this.pendingCommands === 0) this.setState({ busy: false });
    });
  }

  stopRecording(): void {
    this.pendingCommands++;
    this.setState({ busy: true });
    this.armBusyReset();
    this.queue.enqueue(async () => {
      await this.doRequest(CMD_STOP);
      await sleep(COMMAND_COOLDOWN_MS);
    }).catch((err) =>
      this.log('[cq-mixer] stopRecording failed', (err as Error).message)
    ).finally(() => {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      if (this.pendingCommands === 0) this.setState({ busy: false, recording: false });
    });
  }

  setTrackMute(track: number, muted: boolean): void {
    if (track < 0 || track > 7) return;
    const cmd = Buffer.from([0xf7, 0x08, 0x06, 0x0c, track, 0x00, muted ? 0x01 : 0x00, 0x00]);
    const trackMutes = [...this.currentState.trackMutes];
    trackMutes[track] = muted;
    this.setState({ trackMutes });
    this.queue.enqueue(() => this.doRequest(cmd)).catch((err) =>
      this.log('[cq-mixer] setTrackMute failed', (err as Error).message)
    );
  }

  setTrackArm(track: number, armed: boolean): void {
    if (track < 0 || track > 7) return;
    if (armed) {
      this.armBitmask |= (1 << track);
    } else {
      this.armBitmask &= ~(1 << track);
    }
    const cmd = Buffer.from([0xf7, 0x08, 0x11, 0x14, this.armBitmask, 0x00, 0x00, 0x00]);
    const trackArmed = [...this.currentState.trackArmed];
    trackArmed[track] = armed;
    this.setState({ trackArmed });
    this.queue.enqueue(() => this.doRequest(cmd)).catch((err) =>
      this.log('[cq-mixer] setTrackArm failed', (err as Error).message)
    );
  }

  setTrackGain(track: number, db: number): void {
    if (track < 0 || track > 7) return;
    const clamped = Math.max(0, Math.min(60, Math.round(db)));
    const val = 0x80 + clamped;
    const cmd = Buffer.from([0xf7, 0x08, 0x0a, 0x0c, track, 0x01, 0x00, val]);
    const trackGains = [...this.currentState.trackGains];
    trackGains[track] = clamped;
    this.setState({ trackGains });
    this.queue.enqueue(() => this.doRequest(cmd)).catch((err) =>
      this.log('[cq-mixer] setTrackGain failed', (err as Error).message)
    );
  }

  private armBusyReset(): void {
    if (this.busyResetTimer) clearTimeout(this.busyResetTimer);
    this.busyResetTimer = setTimeout(() => {
      if (this.currentState.busy) {
        this.log('[cq-mixer] busy reset timeout — forcing clear');
        this.pendingCommands = 0;
        this.setState({ busy: false, recording: false });
      }
    }, BUSY_RESET_TIMEOUT_MS);
  }

  private setState(update: Partial<CqMixerState>): void {
    this.currentState = { ...this.currentState, ...update };
    this.onStateChange(this.currentState);
  }

  private scheduleProbe(delayMs: number): void {
    this.probeTimer = setTimeout(() => {
      if (this.disposed) return;
      this.probe().finally(() => {
        if (!this.disposed) this.scheduleProbe(PROBE_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async probe(): Promise<void> {
    try {
      const response = await this.doRequest();
      const name = extractDeviceName(response);
      this.setState({ connected: true, name, lastError: '' });
    } catch (err) {
      this.setState({ connected: false, name: '', lastError: (err as Error).message });
    }
  }

  // Connects, sends handshake, waits for mixer's response, optionally sends a command, then closes.
  private doRequest(command?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.ip, port: PORT });
      const chunks: Buffer[] = [];
      let phase: 'connect' | 'handshake' | 'done' = 'connect';
      let settled = false;

      const timeout = setTimeout(() => {
        fail(new Error(`Mixer TCP request timed out (${this.ip}:${PORT})`));
      }, CONNECT_TIMEOUT_MS);

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        if (!socket.destroyed) socket.destroy();
        resolve(Buffer.concat(chunks));
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        if (!socket.destroyed) socket.destroy();
        reject(err);
      };

      socket.once('error', fail);
      socket.once('close', () => { if (!settled) succeed(); });

      socket.once('connect', () => {
        phase = 'handshake';
        socket.write(HANDSHAKE);
      });

      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (phase === 'handshake') {
          phase = 'done';
          if (command) {
            socket.write(command, () => succeed());
          } else {
            succeed();
          }
        }
      });
    });
  }
}

function extractDeviceName(buf: Buffer): string {
  // The response packet contains the device name as a printable ASCII run.
  const match = buf.toString('latin1').match(/[\x20-\x7E]{3,}/);
  return match ? match[0].trim() : '';
}
