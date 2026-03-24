import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import type { Readable } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';
import type { Socket } from 'socket.io';
import {
  type AudioMonitorInputOption,
  type AudioMonitorPreferredInput,
  type AudioMonitorState,
  createDefaultAudioMonitorState,
} from './atem-utils';

type WrtcModule = typeof import('@roamhq/wrtc');

const require = createRequire(import.meta.url);

const FRAME_DURATION_MS = 10;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * FRAME_DURATION_MS / 1000;
const CAPTURE_IDLE_STOP_MS = 3_000;

type AudioMonitorSignalPayload = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type ListenerSession = {
  socket: Socket;
  peer: InstanceType<WrtcModule['RTCPeerConnection']>;
  muted: boolean;
};

type CapturePlatform = 'windows' | 'macos' | 'linux';

type AudioInputDescriptor = {
  deviceKey: string;
  label: string;
};

export class SlateAudioMonitorService {
  private state: AudioMonitorState;
  private listeners = new Map<string, ListenerSession>();
  private captureProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private captureBuffer = Buffer.alloc(0);
  private captureStopTimer: NodeJS.Timeout | null = null;
  private audioSource: InstanceType<WrtcModule['nonstandard']['RTCAudioSource']> | null = null;
  private audioTrack: MediaStreamTrack | null = null;

  constructor(
    preferredInput: AudioMonitorPreferredInput,
    private readonly onStateChange: (state: AudioMonitorState) => void,
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.state = createDefaultAudioMonitorState({ preferredInput });
  }

  getState(): AudioMonitorState {
    return this.state;
  }

  setPreferredInput(preferredInput: AudioMonitorPreferredInput) {
    this.patchState({
      preferredInput,
      availableInputs: this.state.availableInputs,
      sourceAvailable: false,
      capturing: false,
      listenerCount: this.listeners.size,
      webrtcState: preferredInput.deviceKey ? 'idle' : 'no_source',
      lastError: preferredInput.deviceKey ? '' : 'No preferred audio input configured',
      lastCheckedAt: new Date().toISOString(),
    });
  }

  async refreshSourceAvailability(): Promise<AudioMonitorState> {
    const preferred = this.state.preferredInput;
    if (!preferred.deviceKey.trim()) {
      this.patchState({
        sourceAvailable: false,
        webrtcState: 'no_source',
        lastError: 'No preferred audio input configured',
        lastCheckedAt: new Date().toISOString(),
      });
      return this.state;
    }

    try {
      const devices = await this.listAudioInputs();
      const availableInputs: AudioMonitorInputOption[] = devices.map((device) => ({
        deviceKey: device.deviceKey,
        label: device.label,
      }));
      const wanted = preferred.deviceKey.trim().toLowerCase();
      const found = devices.find((device) => {
        const deviceKey = device.deviceKey.trim().toLowerCase();
        const label = device.label.trim().toLowerCase();
        return deviceKey === wanted || label === wanted || deviceKey.includes(wanted) || label.includes(wanted);
      });

      this.patchState({
        availableInputs,
        sourceAvailable: Boolean(found),
        webrtcState: found
          ? (this.listeners.size > 0 ? this.state.webrtcState : 'idle')
          : 'no_source',
        lastError: found ? '' : `Preferred audio input "${preferred.label || preferred.deviceKey}" is unavailable`,
        lastCheckedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.patchState({
        availableInputs: [],
        sourceAvailable: false,
        webrtcState: 'error',
        lastError: `Audio device discovery failed: ${(error as Error).message}`,
        lastCheckedAt: new Date().toISOString(),
      });
    }

    return this.state;
  }

  async handleJoin(socket: Socket) {
    this.clearCaptureStopTimer();
    await this.ensureCaptureRunning();

    let session = this.listeners.get(socket.id);
    if (!session) {
      const peer = this.createPeer(socket);
      session = { socket, peer, muted: false };
      this.listeners.set(socket.id, session);
    }

    this.patchState({
      listenerCount: this.listeners.size,
      webrtcState: this.listeners.size > 0 ? 'connecting' : this.state.webrtcState,
      lastError: '',
    });
  }

  async handleSignal(socketId: string, payload: AudioMonitorSignalPayload) {
    const session = this.listeners.get(socketId);
    if (!session) throw new Error('Audio monitor session has not joined yet');

    if (payload.description) {
      const wrtc = this.loadWrtc();
      await session.peer.setRemoteDescription(new wrtc.RTCSessionDescription(payload.description));
      if (payload.description.type === 'offer') {
        const answer = await session.peer.createAnswer();
        await session.peer.setLocalDescription(answer);
        session.socket.emit('audioMonitorSignal', {
          description: session.peer.localDescription?.toJSON() ?? answer,
        } satisfies AudioMonitorSignalPayload);
      }
    }

    if (payload.candidate) {
      const wrtc = this.loadWrtc();
      await session.peer.addIceCandidate(new wrtc.RTCIceCandidate(payload.candidate));
    }
  }

  handleSetMuted(socketId: string, muted: boolean, autoplayBlocked = false) {
    const session = this.listeners.get(socketId);
    if (!session) return;
    session.muted = muted;

    const allMuted = this.listeners.size > 0 && [...this.listeners.values()].every((listener) => listener.muted);
    this.patchState({
      autoplayBlocked,
      webrtcState: this.listeners.size === 0
        ? (this.state.sourceAvailable ? 'idle' : 'no_source')
        : autoplayBlocked
          ? 'blocked'
          : allMuted
            ? 'muted'
            : 'monitoring',
    });
  }

  async handleLeave(socketId: string) {
    const session = this.listeners.get(socketId);
    if (!session) return;

    this.listeners.delete(socketId);
    try {
      session.peer.onicecandidate = null;
      session.peer.onconnectionstatechange = null;
      session.peer.oniceconnectionstatechange = null;
      session.peer.close();
    } catch {
      // Ignore peer shutdown errors.
    }

    this.patchState({
      listenerCount: this.listeners.size,
      autoplayBlocked: false,
      webrtcState: this.listeners.size === 0
        ? (this.state.sourceAvailable ? 'idle' : 'no_source')
        : [...this.listeners.values()].every((listener) => listener.muted)
          ? 'muted'
          : 'monitoring',
    });

    if (this.listeners.size === 0) {
      this.scheduleCaptureStop();
    }
  }

  async stop() {
    this.clearCaptureStopTimer();
    for (const socketId of [...this.listeners.keys()]) {
      await this.handleLeave(socketId);
    }
    this.stopCapture();
  }

  private createPeer(socket: Socket) {
    const wrtc = this.loadWrtc();
    const peer = new wrtc.RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    if (!this.audioTrack) {
      throw new Error('Audio capture is not ready');
    }

    const stream = new wrtc.MediaStream();
    stream.addTrack(this.audioTrack);
    peer.addTrack(this.audioTrack, stream);

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      socket.emit('audioMonitorSignal', { candidate: event.candidate.toJSON() } satisfies AudioMonitorSignalPayload);
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        this.patchState({
          webrtcState: [...this.listeners.values()].every((listener) => listener.muted) ? 'muted' : 'monitoring',
          lastError: '',
        });
      }

      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' || peer.connectionState === 'closed') {
        this.handleLeave(socket.id).catch((error) =>
          this.log('Audio monitor leave failed', (error as Error).message)
        );
      }
    };

    return peer;
  }

  private async ensureCaptureRunning() {
    if (this.captureProcess && this.audioSource && this.audioTrack) return;

    await this.refreshSourceAvailability();
    if (!this.state.sourceAvailable) {
      throw new Error(this.state.lastError || 'Preferred audio input is unavailable');
    }

    const binary = ffmpegPath;
    if (!binary) {
      this.patchState({
        sourceAvailable: false,
        capturing: false,
        webrtcState: 'error',
        lastError: 'ffmpeg-static binary not found',
      });
      throw new Error('ffmpeg-static binary not found');
    }

    const wrtc = this.loadWrtc();
    this.audioSource = new wrtc.nonstandard.RTCAudioSource();
    this.audioTrack = this.audioSource.createTrack();
    this.captureBuffer = Buffer.alloc(0);

    const args = this.buildCaptureArgs(this.state.preferredInput.deviceKey);
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.captureProcess = proc;

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!this.audioSource) return;
      this.captureBuffer = Buffer.concat([this.captureBuffer, chunk]);
      while (this.captureBuffer.length >= FRAME_BYTES) {
        const frame = this.captureBuffer.subarray(0, FRAME_BYTES);
        this.captureBuffer = this.captureBuffer.subarray(FRAME_BYTES);
        this.audioSource.onData({
          samples: new Int16Array(frame.buffer, frame.byteOffset, frame.byteLength / BYTES_PER_SAMPLE),
          sampleRate: SAMPLE_RATE,
          channelCount: CHANNELS,
          bitsPerSample: 16,
          numberOfFrames: SAMPLE_RATE * FRAME_DURATION_MS / 1000,
        });
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (!line) return;
      if (/error|unable|failed|invalid/i.test(line)) {
        this.patchState({
          lastError: line,
          webrtcState: 'error',
        });
      }
    });

    proc.once('close', (code) => {
      this.captureProcess = null;
      this.captureBuffer = Buffer.alloc(0);
      this.audioTrack?.stop();
      this.audioTrack = null;
      this.audioSource = null;
      this.patchState({
        capturing: false,
        sourceAvailable: false,
        webrtcState: this.listeners.size > 0 ? 'error' : 'no_source',
        lastError: code === 0
          ? this.state.lastError
          : `Audio capture exited unexpectedly (${code ?? 'unknown'})`,
        lastCheckedAt: new Date().toISOString(),
      });
    });

    this.patchState({
      capturing: true,
      listenerCount: this.listeners.size,
      webrtcState: this.listeners.size > 0 ? 'connecting' : 'idle',
      lastError: '',
      lastCheckedAt: new Date().toISOString(),
    });
  }

  private stopCapture() {
    if (this.captureProcess) {
      this.captureProcess.kill();
      this.captureProcess = null;
    }
    this.captureBuffer = Buffer.alloc(0);
    this.audioTrack?.stop();
    this.audioTrack = null;
    this.audioSource = null;
    this.patchState({
      capturing: false,
      webrtcState: this.state.sourceAvailable ? 'idle' : 'no_source',
    });
  }

  private scheduleCaptureStop() {
    this.clearCaptureStopTimer();
    this.captureStopTimer = setTimeout(() => {
      if (this.listeners.size === 0) {
        this.stopCapture();
      }
    }, CAPTURE_IDLE_STOP_MS);
  }

  private clearCaptureStopTimer() {
    if (this.captureStopTimer) {
      clearTimeout(this.captureStopTimer);
      this.captureStopTimer = null;
    }
  }

  private patchState(patch: Partial<AudioMonitorState>) {
    this.state = {
      ...this.state,
      ...patch,
      preferredInput: patch.preferredInput ?? this.state.preferredInput,
      expectedFormat: patch.expectedFormat ?? this.state.expectedFormat,
    };
    this.onStateChange(this.state);
  }

  private async listAudioInputs(): Promise<AudioInputDescriptor[]> {
    const binary = ffmpegPath;
    if (!binary) throw new Error('ffmpeg-static binary not found');

    const currentPlatform = this.getCapturePlatform();
    const args = this.buildListArgs(currentPlatform);

    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      proc.once('error', reject);
      proc.once('close', () => {
        try {
          resolve(this.parseDeviceList(currentPlatform, stderr));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private getCapturePlatform(): CapturePlatform {
    const current = platform();
    if (current === 'win32') return 'windows';
    if (current === 'darwin') return 'macos';
    return 'linux';
  }

  private buildListArgs(currentPlatform: CapturePlatform): string[] {
    if (currentPlatform === 'windows') {
      return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
    }
    if (currentPlatform === 'macos') {
      return ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
    }
    return ['-hide_banner', '-sources', 'pulse'];
  }

  private buildCaptureArgs(deviceKey: string): string[] {
    const currentPlatform = this.getCapturePlatform();
    const inputArgs =
      currentPlatform === 'windows'
        ? ['-f', 'dshow', '-i', `audio=${deviceKey}`]
        : currentPlatform === 'macos'
          ? ['-f', 'avfoundation', '-i', `:${deviceKey}`]
          : ['-f', 'pulse', '-i', deviceKey];

    return [
      '-hide_banner',
      '-loglevel', 'warning',
      ...inputArgs,
      '-vn',
      '-ac', String(CHANNELS),
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1',
    ];
  }

  private parseDeviceList(currentPlatform: CapturePlatform, stderr: string): AudioInputDescriptor[] {
    if (currentPlatform === 'windows') {
      return [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/gi)].map((match) => ({
        deviceKey: match[1],
        label: match[1],
      }));
    }

    if (currentPlatform === 'macos') {
      return [...stderr.matchAll(/\[(\d+)\]\s+(.+)$/gm)].map((match) => ({
        deviceKey: match[1],
        label: match[2].trim(),
      }));
    }

    return stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('* '))
      .map((line) => {
        const label = line.replace(/^\*\s+/, '');
        return {
          deviceKey: label,
          label,
        };
      });
  }

  private loadWrtc(): WrtcModule {
    return require('@roamhq/wrtc') as WrtcModule;
  }
}
