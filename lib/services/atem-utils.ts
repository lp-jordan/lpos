export const RESERVED_NOTE_CODE = 'ATEM';

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const SPACE_RUN = /\s+/g;
const UNDERSCORE_RUN = /_+/g;

export interface SlateNote {
  timestamp: string;
  code: string;
  note: string;
}

export interface AtemInput {
  id: number;
  label: string;
}

export interface AtemRecordingState {
  isRecording: boolean;
  filename: string;
  status: string;
}

export interface AtemState {
  bridgeAvailable: boolean;
  bridgeMode: string;
  connected: boolean;
  switcherIp: string;
  inputs: AtemInput[];
  previewInput: number | null;
  programInput: number | null;
  recording: AtemRecordingState;
  lastError: string;
  lastCommandAt: string | null;
}

export interface PlaybackConnectionState {
  connected: boolean;
  host: string;
  port: number;
  lastCheckedAt: string | null;
  lastError: string;
  sessions: PlaybackSessionEntry[];
}

export interface PlaybackRemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  raw: string;
}

export interface PlaybackClipEntry {
  name: string;
  path: string;
  sessionName: string;
}

export interface PlaybackSessionEntry {
  name: string;
  path: string;
  clips: PlaybackClipEntry[];
}

export interface AudioMonitorPreferredInput {
  deviceKey: string;
  label: string;
}

export interface AudioMonitorInputOption {
  deviceKey: string;
  label: string;
}

export interface AudioMonitorExpectedFormat {
  sampleRate: number;
  channels: number;
  sampleFormat: 's16le';
  frameDurationMs: number;
}

export type AudioMonitorWebRtcState =
  | 'idle'
  | 'no_source'
  | 'connecting'
  | 'monitoring'
  | 'muted'
  | 'blocked'
  | 'error';

export interface AudioMonitorState {
  preferredInput: AudioMonitorPreferredInput;
  availableInputs: AudioMonitorInputOption[];
  expectedFormat: AudioMonitorExpectedFormat;
  sourceAvailable: boolean;
  capturing: boolean;
  listenerCount: number;
  webrtcState: AudioMonitorWebRtcState;
  autoplayBlocked: boolean;
  lastError: string;
  lastCheckedAt: string | null;
}

export function createTimestamp(date = new Date()): string {
  const frames = Math.floor(date.getMilliseconds() * 24000 / 1001000);
  return `${date.toTimeString().split(' ')[0]}:${String(frames).padStart(2, '0')}`;
}

export function sanitizeProjectName(name: string): string {
  if (!name || typeof name !== 'string') return 'session';
  const sanitized = name.trim()
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(SPACE_RUN, '_')
    .replace(UNDERSCORE_RUN, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '');
  return sanitized || 'session';
}

export function formatDateStamp(date = new Date()): string {
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}-${year}`;
}

export function generateRecordingBaseName(projectName: string, date = new Date(), clientName?: string): string {
  const project = sanitizeProjectName(projectName);
  const datestamp = formatDateStamp(date);
  if (clientName?.trim()) {
    return `${sanitizeProjectName(clientName)}_${project}_${datestamp}`;
  }
  return `${project}_${datestamp}`;
}

export function createNote(code: string, note: string, date = new Date()): SlateNote {
  return { timestamp: createTimestamp(date), code, note };
}

export function createAtemNote(note: string, date = new Date()): SlateNote {
  return createNote(RESERVED_NOTE_CODE, note, date);
}

export function labelForInput(state: AtemState, inputId: number | null): string {
  if (inputId == null) return 'None';
  const input = state.inputs.find((i) => String(i.id) === String(inputId));
  return input ? input.label : `Input ${inputId}`;
}

export function createDefaultAtemState(overrides: Partial<AtemState> = {}): AtemState {
  return {
    bridgeAvailable: false,
    bridgeMode: 'unknown',
    connected: false,
    switcherIp: '',
    inputs: [],
    previewInput: null,
    programInput: null,
    recording: { isRecording: false, filename: '', status: 'disconnected' },
    lastError: '',
    lastCommandAt: null,
    ...overrides,
  };
}

export function createDefaultPlaybackConnectionState(
  overrides: Partial<PlaybackConnectionState> = {}
): PlaybackConnectionState {
  return {
    connected: false,
    host: '',
    port: 21,
    lastCheckedAt: null,
    lastError: '',
    sessions: [],
    ...overrides,
  };
}

export function createDefaultAudioMonitorState(
  overrides: Partial<AudioMonitorState> = {}
): AudioMonitorState {
  return {
    preferredInput: {
      deviceKey: '',
      label: '',
    },
    availableInputs: [],
    expectedFormat: {
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: 's16le',
      frameDurationMs: 10,
    },
    sourceAvailable: false,
    capturing: false,
    listenerCount: 0,
    webrtcState: 'no_source',
    autoplayBlocked: false,
    lastError: '',
    lastCheckedAt: null,
    ...overrides,
  };
}
