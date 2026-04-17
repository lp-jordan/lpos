import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ServiceRegistry } from './registry';
import { AtemBridgeClient } from './atem-bridge-client';
import { SerialTaskQueue } from './serial-task-queue';
import {
  type AtemState,
  type AudioMonitorPreferredInput,
  type AudioMonitorState,
  type PlaybackClipEntry,
  type PlaybackConnectionState,
  type PlaybackRemoteEntry,
  type PlaybackSessionEntry,
  type SlateNote,
  createAtemNote,
  createDefaultAudioMonitorState,
  createDefaultAtemState,
  createDefaultPlaybackConnectionState,
  createTimestamp,
  generateRecordingBaseName,
  labelForInput,
} from './atem-utils';
import type { ProjectStore } from '@/lib/store/project-store';
import { SlateAudioMonitorService } from './slate-audio-monitor';

// ── Data directory ─────────────────────────────────────────────────────────

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const SLATE_CONFIG_PATH = path.join(DATA_DIR, 'slate.config.json');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Config ─────────────────────────────────────────────────────────────────

interface SlateConfig {
  atem: { switcherIp: string; bridgePort: number };
  audio: {
    preferredInput: AudioMonitorPreferredInput;
    expectedFormat: {
      sampleRate: number;
      channels: number;
      sampleFormat: 's16le';
      frameDurationMs: number;
    };
  };
  lastProjectId: string | null;
}

function defaultConfig(): SlateConfig {
  return {
    atem: { switcherIp: '', bridgePort: Number(process.env.ATEM_BRIDGE_PORT ?? 4011) },
    audio: {
      preferredInput: {
        deviceKey: process.env.LPOS_AUDIO_DEVICE_KEY ?? '',
        label: process.env.LPOS_AUDIO_DEVICE_LABEL ?? '',
      },
      expectedFormat: {
        sampleRate: 48_000,
        channels: 2,
        sampleFormat: 's16le',
        frameDurationMs: 10,
      },
    },
    lastProjectId: null,
  };
}

function loadConfig(): SlateConfig {
  ensureDir(path.dirname(SLATE_CONFIG_PATH));
  if (!fs.existsSync(SLATE_CONFIG_PATH)) return defaultConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(SLATE_CONFIG_PATH, 'utf8')) as Partial<SlateConfig>;
    return {
      ...defaultConfig(),
      ...parsed,
      atem: { ...defaultConfig().atem, ...(parsed.atem ?? {}) },
      audio: {
        ...defaultConfig().audio,
        ...(parsed.audio ?? {}),
        preferredInput: {
          ...defaultConfig().audio.preferredInput,
          ...(parsed.audio?.preferredInput ?? {}),
        },
        expectedFormat: {
          ...defaultConfig().audio.expectedFormat,
          ...(parsed.audio?.expectedFormat ?? {}),
        },
      },
    };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(cfg: SlateConfig) {
  ensureDir(path.dirname(SLATE_CONFIG_PATH));
  fs.writeFileSync(SLATE_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── Notes persistence ──────────────────────────────────────────────────────

function notesPath(projectId: string): string {
  return path.join(DATA_DIR, 'projects', projectId, 'slate-notes.json');
}

function readNotes(projectId: string): SlateNote[] {
  const file = notesPath(projectId);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as SlateNote[]; }
  catch { return []; }
}

function writeNotes(projectId: string, notes: SlateNote[]) {
  const file = notesPath(projectId);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(notes, null, 2));
}

// ── Service ────────────────────────────────────────────────────────────────

export class SlateService {
  private config = loadConfig();
  private currentProjectId: string | null = null;
  private notes: SlateNote[] = [];
  private codeText = '';
  private atemState: AtemState = createDefaultAtemState({ switcherIp: this.config.atem.switcherIp });
  private audioMonitorState: AudioMonitorState = createDefaultAudioMonitorState({
    preferredInput: this.config.audio.preferredInput,
    expectedFormat: this.config.audio.expectedFormat,
  });
  private playbackConnection: PlaybackConnectionState = createDefaultPlaybackConnectionState({ host: this.config.atem.switcherIp });
  private atemFilenameBase = '';
  private atemQueue = new SerialTaskQueue();
  private atemBridge: AtemBridgeClient;
  private audioMonitor: SlateAudioMonitorService;
  private atemInterval: NodeJS.Timeout | null = null;
  private playbackInterval: NodeJS.Timeout | null = null;
  private logBuffer: string[] = [];

  constructor(
    private io: SocketIOServer,
    private registry: ServiceRegistry,
    private projectStore: ProjectStore,
  ) {
    this.atemBridge = new AtemBridgeClient({
      port: this.config.atem.bridgePort,
      log: (...args) => this.log(...args),
    });
    this.audioMonitor = new SlateAudioMonitorService(
      this.config.audio.preferredInput,
      (state) => {
        this.audioMonitorState = {
          ...state,
          expectedFormat: this.config.audio.expectedFormat,
        };
        this.emitAudioMonitorState();
      },
      (...args) => this.log(...args),
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.registry.register('slate', 'LeaderSlate');

    // Restore last project
    if (this.config.lastProjectId) {
      const exists = this.projectStore.getById(this.config.lastProjectId);
      if (exists) this.loadProject(this.config.lastProjectId);
    }

    // Wire socket namespace
    const ns = this.io.of('/slate');
    ns.on('connection', (socket) => this.onConnect(socket));

    // Initial ATEM state + auto-connect
    await this.refreshAtemState();
    await this.audioMonitor.refreshSourceAvailability();
    await this.refreshPlaybackConnectionState();
    if (this.config.atem.switcherIp) {
      this.executeAtemCommand(this.io.of('/slate'), 'Auto-connect', () =>
        this.atemBridge.connect(this.config.atem.switcherIp)
      ).catch((err) => this.log('ATEM auto-connect skipped', (err as Error).message));
    }

    // Periodic ATEM state refresh
    this.atemInterval = setInterval(() => {
      this.refreshAtemState().catch((err) =>
        this.log('ATEM state refresh failed', (err as Error).message)
      );
    }, 2000);
    this.playbackInterval = setInterval(() => {
      this.refreshPlaybackConnectionState().catch((err) =>
        this.log('Playback FTP refresh failed', (err as Error).message)
      );
    }, 5000);

    this.registry.update('slate', 'running');
    this.log('LeaderSlate service running');
  }

  async stop(): Promise<void> {
    if (this.atemInterval) clearInterval(this.atemInterval);
    if (this.playbackInterval) clearInterval(this.playbackInterval);
    await this.audioMonitor.stop();
    this.atemBridge.dispose();
    this.registry.update('slate', 'stopped');
  }

  // ── Socket connection ──────────────────────────────────────────────────

  private onConnect(socket: Socket) {
    this.log('Slate client connected', socket.id);

    // Replay buffered logs so the dev console shows history from before this connection
    for (const line of this.logBuffer) {
      socket.emit('log', line);
    }

    // Send initial state
    if (this.currentProjectId) {
      socket.emit('projectLoaded', this.projectLoadedPayload());
    } else {
      socket.emit('noActiveProject');
    }
    if (this.codeText) socket.emit('codeUpdate', this.codeText);
    this.emitAtemState(socket);
    this.emitAudioMonitorState(socket);
    this.emitPlaybackConnectionState(socket);

    // ── Note events ──
    socket.on('addNote', (data: { code: string; note: string }) => {
      if (!this.currentProjectId) { socket.emit('error', 'No project loaded'); return; }
      const note = { timestamp: createTimestamp(), code: data.code, note: data.note };
      this.addNote(note);
      this.log('Added note', note);
    });

    socket.on('editNote', (data: { index: number; code: string; note: string }) => {
      if (typeof data.index !== 'number' || !this.notes[data.index]) return;
      this.notes[data.index].code = data.code;
      this.notes[data.index].note = data.note;
      if (this.currentProjectId) writeNotes(this.currentProjectId, this.notes);
      this.io.of('/slate').emit('noteEdited', { index: data.index, note: this.notes[data.index] });
    });

    socket.on('deleteNote', (index: number) => {
      if (typeof index !== 'number' || !this.notes[index]) return;
      this.notes.splice(index, 1);
      if (this.currentProjectId) writeNotes(this.currentProjectId, this.notes);
      this.io.of('/slate').emit('noteDeleted', index);
    });

    socket.on('deleteNotes', (indices: number[]) => {
      if (!Array.isArray(indices)) return;
      const unique = [...new Set(indices.filter((i) => typeof i === 'number' && this.notes[i]))]
        .sort((a, b) => b - a);
      for (const idx of unique) { if (this.notes[idx]) this.notes.splice(idx, 1); }
      if (unique.length > 0) {
        if (this.currentProjectId) writeNotes(this.currentProjectId, this.notes);
        this.io.of('/slate').emit('notesDeleted', unique);
      }
    });

    // ── Project events ──
    socket.on('loadProject', (projectId: string) => {
      const project = this.projectStore.getById(projectId);
      if (!project) return;
      this.loadProject(projectId);
      this.io.of('/slate').emit('projectLoaded', this.projectLoadedPayload());
      this.log('Switched to project', projectId);
    });

    // ── Code sync ──
    socket.on('codeUpdate', (value: string) => {
      this.codeText = value;
      socket.broadcast.emit('codeUpdate', value);
    });

    // ── ATEM events ──
    socket.on('requestAtemState', () => this.emitAtemState(socket));
    socket.on('audioMonitorJoin', async () => {
      try {
        await this.audioMonitor.handleJoin(socket);
      } catch (err) {
        socket.emit('audioMonitorError', { message: (err as Error).message });
      }
    });

    socket.on('audioMonitorLeave', async () => {
      await this.audioMonitor.handleLeave(socket.id);
    });

    socket.on('audioMonitorSignal', async (payload: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
      try {
        await this.audioMonitor.handleSignal(socket.id, payload);
      } catch (err) {
        socket.emit('audioMonitorError', { message: (err as Error).message });
      }
    });

    socket.on('audioMonitorSetMuted', (payload: { muted?: boolean; autoplayBlocked?: boolean }) => {
      this.audioMonitor.handleSetMuted(socket.id, Boolean(payload?.muted), Boolean(payload?.autoplayBlocked));
    });

    socket.on('audioMonitorSetInput', async (payload: { deviceKey?: string; label?: string }) => {
      const deviceKey = (payload?.deviceKey ?? '').trim();
      const label = (payload?.label ?? '').trim();

      this.config.audio.preferredInput = { deviceKey, label: label || deviceKey };
      saveConfig(this.config);
      this.audioMonitor.setPreferredInput(this.config.audio.preferredInput);

      try {
        await this.audioMonitor.refreshSourceAvailability();
        socket.emit('atemCommandResult', {
          type: 'success',
          message: deviceKey ? `Audio input set to ${label || deviceKey}` : 'Audio input cleared',
        });
      } catch (err) {
        socket.emit('audioMonitorError', { message: (err as Error).message });
      }
    });

    socket.on('atemConnect', async (payload: { ipAddress?: string }) => {
      const ip = (payload?.ipAddress ?? '').trim();
      if (!ip) { this.emitAtemToast(socket, 'error', 'Enter the ATEM IP address first'); return; }
      try {
        await this.executeAtemCommand(socket, 'Connect', async () => {
          this.config.atem.switcherIp = ip;
          saveConfig(this.config);
          await this.atemBridge.connect(ip);
        });
        // State was refreshed inside executeAtemCommand; report actual connection status
        if (this.atemState.connected) {
          this.emitAtemToast(socket, 'success', `Connected to ATEM at ${ip}`);
        } else {
          this.emitAtemToast(socket, 'info', `Connecting to ${ip}\u2026 auto-reconnect is active`);
        }
        await this.refreshPlaybackConnectionState();
      } catch (err) { this.log('ATEM connect failed', (err as Error).message); }
    });

    socket.on('atemDisconnect', async () => {
      try {
        await this.executeAtemCommand(socket, 'Disconnect', () => this.atemBridge.disconnect(),
          { successMessage: 'Disconnected from ATEM' });
        await this.refreshPlaybackConnectionState();
      } catch (err) { this.log('ATEM disconnect failed', (err as Error).message); }
    });

    socket.on('atemSetPreview', async (payload: { inputId?: number }) => {
      if (payload?.inputId == null) return;
      try {
        await this.executeAtemCommand(socket, 'Set preview', () =>
          this.atemBridge.setPreviewInput(payload.inputId!),
          { successMessage: `Preview → ${labelForInput(this.atemState, payload.inputId!)}` });
      } catch (err) { this.log('ATEM preview failed', (err as Error).message); }
    });

    socket.on('atemSetProgram', async (payload: { inputId?: number }) => {
      if (payload?.inputId == null) return;
      try {
        await this.executeAtemCommand(socket, 'Set program', () =>
          this.atemBridge.setProgramInput(payload.inputId!),
          { successMessage: `Program → ${labelForInput(this.atemState, payload.inputId!)}` });
      } catch (err) { this.log('ATEM program failed', (err as Error).message); }
    });

    socket.on('atemCut', async () => {
      try {
        await this.executeAtemCommand(socket, 'Cut', () => this.atemBridge.performCut(),
          { successMessage: `Cut → ${labelForInput(this.atemState, this.atemState.programInput)}` });
      } catch (err) { this.log('ATEM cut failed', (err as Error).message); }
    });

    socket.on('atemAuto', async () => {
      try {
        await this.executeAtemCommand(socket, 'Auto', () => this.atemBridge.performAuto(),
          { successMessage: `Auto → ${labelForInput(this.atemState, this.atemState.programInput)}` });
      } catch (err) { this.log('ATEM auto failed', (err as Error).message); }
    });

    socket.on('atemSetFilename', async (payload: { filename?: string }) => {
      const filename = (payload?.filename ?? '').trim();
      if (!filename) { this.emitAtemToast(socket, 'error', 'Enter a recording filename'); return; }
      try {
        this.ensureProjectSelected();
        this.atemFilenameBase = filename;
        await this.executeAtemCommand(socket, 'Set filename', () =>
          this.atemBridge.setRecordingFilename(filename),
          { successMessage: `Filename set to ${filename}` });
      } catch (err) { this.log('ATEM filename failed', (err as Error).message); }
    });

    socket.on('atemStartRecording', async (payload?: { filename?: string }) => {
      const filename = ((payload?.filename ?? '') || this.atemFilenameBase).trim();
      if (!filename) { this.emitAtemToast(socket, 'error', 'Recording filename is required'); return; }
      try {
        this.ensureProjectSelected();
        this.atemFilenameBase = filename;
        await this.executeAtemCommand(socket, 'Start recording', async () => {
          await this.atemBridge.setRecordingFilename(filename);
          await this.atemBridge.startRecording();
        }, { successMessage: `Recording started: ${filename}` });
        this.addAutomaticAtemNote(`Recording started (${filename})`);
      } catch (err) { this.log('ATEM start recording failed', (err as Error).message); }
    });

    socket.on('atemStopRecording', async () => {
      try {
        this.ensureProjectSelected();
        await this.executeAtemCommand(socket, 'Stop recording', () => this.atemBridge.stopRecording(),
          { successMessage: 'Recording stopped' });
        this.addAutomaticAtemNote(`Recording stopped (${this.atemFilenameBase || this.atemState.recording.filename || 'unnamed'})`);
        this.emitAtemState();
      } catch (err) { this.log('ATEM stop recording failed', (err as Error).message); }
    });

    socket.on('atemSetOutput4Mode', async (payload: { mode?: string }) => {
      const mode = payload?.mode === 'program' ? 'program' : payload?.mode === 'multiview' ? 'multiview' : '';
      if (!mode) { this.emitAtemToast(socket, 'error', 'Choose program or multiview for Output 4'); return; }
      try {
        await this.executeAtemCommand(socket, 'Set Output 4', () => this.atemBridge.setOutput4Mode(mode),
          { successMessage: `Output 4 → ${mode === 'program' ? 'Fullscreen Program' : 'Multiview'}` });
      } catch (err) { this.log('ATEM output 4 failed', (err as Error).message); }
    });

    socket.on('disconnect', async () => {
      await this.audioMonitor.handleLeave(socket.id);
      this.log('Slate client disconnected', socket.id);
    });
  }

  // ── Project helpers ────────────────────────────────────────────────────

  private loadProject(projectId: string) {
    this.notes = readNotes(projectId);
    this.currentProjectId = projectId;
    const project = this.projectStore.getById(projectId);
    if (project) this.atemFilenameBase = generateRecordingBaseName(project.name, new Date(), project.clientName);
    this.config.lastProjectId = projectId;
    saveConfig(this.config);
    this.emitAtemState();
    this.log(`Loaded project ${projectId} (${this.notes.length} notes)`);
  }

  private projectLoadedPayload() {
    return { projectId: this.currentProjectId, notes: this.notes };
  }

  // ── Note helpers ───────────────────────────────────────────────────────

  private addNote(note: SlateNote) {
    this.notes.push(note);
    if (this.currentProjectId) writeNotes(this.currentProjectId, this.notes);
    this.io.of('/slate').emit('noteAdded', note);
  }

  private addAutomaticAtemNote(message: string) {
    if (!this.currentProjectId) return;
    this.addNote(createAtemNote(message));
  }

  // ── ATEM helpers ───────────────────────────────────────────────────────

  private ensureProjectSelected() {
    if (!this.currentProjectId) {
      const err = new Error('Select a project before using recording controls');
      (err as Error & { code?: string }).code = 'NO_PROJECT';
      throw err;
    }
  }

  private emitAtemState(target: { emit: (ev: string, data: unknown) => void } = this.io.of('/slate')) {
    target.emit('atemState', {
      ...this.atemState,
      recording: {
        ...this.atemState.recording,
        filename: this.atemFilenameBase || this.atemState.recording.filename || '',
      },
    });
  }

  private emitAudioMonitorState(
    target: { emit: (ev: string, data: unknown) => void } = this.io.of('/slate')
  ) {
    target.emit('audioMonitorState', this.audioMonitorState);
  }

  private emitPlaybackConnectionState(
    target: { emit: (ev: string, data: unknown) => void } = this.io.of('/slate')
  ) {
    target.emit('playbackConnectionState', this.playbackConnection);
  }

  private emitAtemToast(target: { emit: (ev: string, data: unknown) => void }, type: string, message: string) {
    target.emit('atemCommandResult', { type, message });
  }

  private async refreshAtemState(): Promise<AtemState> {
    try {
      const available = await this.atemBridge.ensureHelper();
      if (!available) {
        this.atemState = createDefaultAtemState({ bridgeAvailable: false, switcherIp: this.config.atem.switcherIp, lastError: 'ATEM bridge unavailable' });
        this.emitAtemState();
        return this.atemState;
      }
      const bridgeState = await this.atemBridge.getState();
      this.atemState = { ...createDefaultAtemState(), ...bridgeState, bridgeAvailable: true, switcherIp: bridgeState.switcherIp || this.config.atem.switcherIp };
      if (!this.atemFilenameBase) this.atemFilenameBase = this.atemState.recording.filename || '';
      this.emitAtemState();
      return this.atemState;
    } catch (err) {
      this.atemState = { ...this.atemState, bridgeAvailable: false, connected: false, lastError: (err as Error).message };
      this.emitAtemState();
      return this.atemState;
    }
  }

  private async refreshPlaybackConnectionState(): Promise<PlaybackConnectionState> {
    const host = this.config.atem.switcherIp.trim();
    const previousConnection = this.playbackConnection;
    const previousSessions =
      previousConnection.host === host ? previousConnection.sessions : [];

    if (!host) {
      this.playbackConnection = createDefaultPlaybackConnectionState({
        host: '',
        lastCheckedAt: new Date().toISOString(),
        lastError: 'No ATEM IP configured',
      });
      this.emitPlaybackConnectionState();
      return this.playbackConnection;
    }

    try {
      await probeAnonymousFtp(host, 21);
    } catch (err) {
      this.playbackConnection = createDefaultPlaybackConnectionState({
        connected: false,
        host,
        port: 21,
        lastCheckedAt: new Date().toISOString(),
        lastError: (err as Error).message,
      });
      this.emitPlaybackConnectionState();
      return this.playbackConnection;
    }

    try {
      const sessions = await discoverPlaybackSessions(host, 21);
      this.playbackConnection = createDefaultPlaybackConnectionState({
        connected: true,
        host,
        port: 21,
        lastCheckedAt: new Date().toISOString(),
        lastError: '',
        sessions,
      });
    } catch (err) {
      this.playbackConnection = createDefaultPlaybackConnectionState({
        connected: true,
        host,
        port: 21,
        lastCheckedAt: new Date().toISOString(),
        lastError: (err as Error).message,
        sessions: previousSessions,
      });
    }

    this.emitPlaybackConnectionState();
    return this.playbackConnection;
  }

  private async executeAtemCommand(
    target: { emit: (ev: string, data: unknown) => void },
    label: string,
    action: () => Promise<unknown>,
    options: { successMessage?: string } = {}
  ): Promise<void> {
    return this.atemQueue.enqueue(async () => {
      try {
        await action();
        await this.refreshAtemState();
        if (options.successMessage) this.emitAtemToast(target, 'success', options.successMessage);
      } catch (err) {
        this.atemState = { ...this.atemState, lastError: (err as Error).message };
        this.emitAtemState();
        this.emitAtemToast(target, 'error', `${label} failed: ${(err as Error).message}`);
        throw err;
      }
    });
  }

  // ── Logging ────────────────────────────────────────────────────────────

  private log(...args: unknown[]) {
    console.log('[slate]', ...args);
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const line = `[slate] ${msg}`;
    this.logBuffer = [...this.logBuffer.slice(-199), line];
    this.io.of('/slate').emit('log', line);
  }

  // ── Public API (for API routes) ────────────────────────────────────────

  getProjects() {
    return this.projectStore.getAll().map((p) => ({ projectId: p.projectId, name: p.name, clientName: p.clientName }));
  }

  getCurrentState() {
    return {
      currentProjectId: this.currentProjectId,
      notes: this.notes,
      atemState: this.atemState,
      audioMonitorState: this.audioMonitorState,
      playbackConnection: this.playbackConnection,
    };
  }
}

function probeAnonymousFtp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`FTP connection timed out for ${host}:${port}`));
    }, 5000);

    let buffer = '';
    let sentUser = false;
    let sentPass = false;
    let done = false;

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
    };

    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };

    const succeed = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const handleLine = (line: string) => {
      const code = Number(line.slice(0, 3));
      if (!Number.isFinite(code)) return;

      if (code === 220 && !sentUser) {
        sentUser = true;
        socket.write('USER anonymous\r\n');
        return;
      }

      if (code === 331 && sentUser && !sentPass) {
        sentPass = true;
        socket.write('PASS leaderslate@example.com\r\n');
        return;
      }

      if (code === 230) {
        socket.write('QUIT\r\n');
        succeed();
        return;
      }

      if (code >= 400) {
        fail(new Error(line.slice(4).trim() || `FTP error ${code}`));
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) handleLine(line.trim());
      }
    });
    socket.on('error', (error) => fail(error));
    socket.on('close', () => {
      if (!done) fail(new Error(`FTP connection closed for ${host}:${port}`));
    });
  });
}

async function discoverPlaybackSessions(host: string, port: number): Promise<PlaybackSessionEntry[]> {
  const client = new MinimalFtpClient(host, port);
  try {
    await client.connectAnonymous();

    const rootEntries = await client.list();
    const rootFolder = rootEntries.find((entry) => entry.isDirectory && !entry.name.startsWith('.'));
    if (!rootFolder) return [];

    const sessionEntries = await client.list(rootFolder.path);
    const sessions: PlaybackSessionEntry[] = [];

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory) continue;
      if (sessionEntry.name.startsWith('.')) continue;

      const isoFolderPath = joinFtpPath(sessionEntry.path, 'Video ISO Files');
      let isoEntries: PlaybackRemoteEntry[];
      try {
        isoEntries = await client.list(isoFolderPath);
      } catch {
        continue;
      }

      const clips: PlaybackClipEntry[] = [];
      for (const entry of isoEntries) {
        if (entry.isDirectory) continue;
        if (entry.name.startsWith('.')) continue;
        if (!isTargetCamClip(entry.name)) continue;
        clips.push({
          name: entry.name,
          path: entry.path,
          sessionName: sessionEntry.name,
        });
      }

      sessions.push({
        name: sessionEntry.name,
        path: sessionEntry.path,
        clips: clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      });
    }

    return sessions.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally {
    await client.close();
  }
}

class MinimalFtpClient {
  private control: net.Socket | null = null;
  private buffer = '';
  private readonly timeoutMs = 8000;
  private closing = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  async connectAnonymous(): Promise<void> {
    this.closing = false;
    this.control = net.createConnection({ host: this.host, port: this.port });
    this.control.setEncoding('utf8');

    await this.readExpected([220]);
    await this.sendCommand('USER anonymous', [230, 331]);
    const passResponse = this.lastResponseCode;
    if (passResponse === 331) {
      await this.sendCommand('PASS leaderslate@example.com', [230]);
    }
  }

  private lastResponseCode = 0;

  async list(path?: string): Promise<PlaybackRemoteEntry[]> {
    const pasv = await this.sendCommand('PASV', [227]);
    const endpoint = parsePasvEndpoint(pasv.message);
    const dataSocket = net.createConnection(endpoint);
    dataSocket.setEncoding('utf8');

    const dataPromise = new Promise<string>((resolve, reject) => {
      let payload = '';
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        settled = true;
        reject(new Error(`FTP data connection timed out for ${this.host}:${this.port}`));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        dataSocket.removeAllListeners();
        if (!dataSocket.destroyed) dataSocket.destroySoon();
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      dataSocket.on('data', (chunk: string) => {
        payload += chunk;
      });
      dataSocket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') {
          finish();
          return;
        }
        fail(error);
      });
      dataSocket.on('close', () => {
        finish();
      });
    });

    const normalizedPath = normalizeFtpPath(path);
    const command = normalizedPath ? `LIST ${normalizedPath}` : 'LIST';
    await this.sendCommand(command, [125, 150]);
    await this.readExpected([226]);
    const data = await dataPromise;

    return data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseFtpListLine(line, normalizedPath || '/'));
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

  private async sendCommand(
    command: string,
    expectedCodes: number[]
  ): Promise<{ code: number; message: string }> {
    if (!this.control) throw new Error('FTP control connection is not established');
    this.control.write(`${command}\r\n`);
    return this.readExpected(expectedCodes);
  }

  private async readExpected(expectedCodes: number[]): Promise<{ code: number; message: string }> {
    if (!this.control) throw new Error('FTP control connection is not established');

    return new Promise((resolve, reject) => {
      const socket = this.control!;
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        settled = true;
        reject(new Error(`FTP control response timed out for ${this.host}:${this.port}`));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };

      const onError = (error: NodeJS.ErrnoException) => {
        if (settled) return;
        if (this.closing && error.code === 'ECONNRESET') {
          settled = true;
          cleanup();
          reject(new Error('FTP control connection closed during shutdown'));
          return;
        }
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

function parseFtpListLine(line: string, parentPath = '/'): PlaybackRemoteEntry {
  const windowsMatch = line.match(/^(\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}[AP]M)\s+(<DIR>|\d+)\s+(.+)$/i);
  if (windowsMatch) {
    const isDirectory = windowsMatch[3].toUpperCase() === '<DIR>';
    const name = windowsMatch[4].trim();
    return {
      name,
      path: joinFtpPath(parentPath, name),
      isDirectory,
      raw: line,
    };
  }

  const unixMatch = line.match(/^([\-ld])([rwx\-]{9})\s+\d+\s+\S+\s+\S+\s+\d+\s+\w+\s+\d+\s+[\d:]{4,5}\s+(.+)$/);
  if (unixMatch) {
    const name = unixMatch[3].trim();
    return {
      name,
      path: joinFtpPath(parentPath, name),
      isDirectory: unixMatch[1] === 'd',
      raw: line,
    };
  }

  return {
    name: line,
    path: joinFtpPath(parentPath, line),
    isDirectory: false,
    raw: line,
  };
}

function joinFtpPath(parent: string, child: string): string {
  const normalizedParent = parent === '/' ? '' : parent.replace(/\/+$/, '');
  const normalizedChild = child.replace(/^\/+/, '');
  return `${normalizedParent}/${normalizedChild}` || '/';
}

function normalizeFtpPath(path?: string): string {
  if (!path) return '';
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed;
}

function isTargetCamClip(name: string): boolean {
  return /CAM\s*1\s*\d+\.mp4$/i.test(name);
}
