'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  AtemState,
  AudioMonitorInputOption,
  AudioMonitorState,
  AudioMonitorWebRtcState,
  PlaybackConnectionState,
  SlateNote,
} from '@/lib/services/atem-utils';

export type StudioTab = 'notes' | 'atem' | 'lighting' | 'camera' | 'audio' | 'playback';

export interface SlateProject {
  projectId: string;
  name: string;
  clientName: string;
  phase?: string;
}

export interface AtemToast {
  type: 'success' | 'error';
  message: string;
}

export interface ClientAudioMonitorState extends AudioMonitorState {
  joined: boolean;
  locallyMuted: boolean;
  phase: AudioMonitorWebRtcState;
  statusLabel: string;
}

export interface SlateState {
  socketConnected: boolean;
  currentProjectId: string | null;
  notes: SlateNote[];
  codeText: string;
  atemState: AtemState | null;
  audioMonitor: ClientAudioMonitorState;
  playbackConnection: PlaybackConnectionState | null;
  atemToast: AtemToast | null;
  logs: string[];
  projects: SlateProject[];
}

export interface SlateActions {
  loadProject: (projectId: string) => void;
  addNote: (code: string, note: string) => void;
  editNote: (index: number, code: string, note: string) => void;
  deleteNote: (index: number) => void;
  deleteNotes: (indices: number[]) => void;
  updateCode: (value: string) => void;
  atemConnect: (ip: string) => void;
  atemDisconnect: () => void;
  atemSetPreview: (inputId: number) => void;
  atemSetProgram: (inputId: number) => void;
  atemCut: () => void;
  atemAuto: () => void;
  atemStartRecording: (filename?: string) => void;
  atemStopRecording: () => void;
  atemSetFilename: (filename: string) => void;
  atemSetOutput4Mode: (mode: 'program' | 'multiview') => void;
  setStudioTab: (tab: StudioTab) => void;
  joinAudioMonitor: () => void;
  leaveAudioMonitor: () => void;
  setAudioMonitorMuted: (muted: boolean) => void;
  setAudioMonitorInput: (input: AudioMonitorInputOption | null) => void;
  dismissToast: () => void;
}

const DEFAULT_ATEM_STATE: AtemState = {
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
};

const DEFAULT_PLAYBACK_CONNECTION_STATE: PlaybackConnectionState = {
  connected: false,
  host: '',
  port: 21,
  lastCheckedAt: null,
  lastError: '',
  sessions: [],
};

const DEFAULT_AUDIO_MONITOR_STATE: ClientAudioMonitorState = {
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
  joined: false,
  locallyMuted: true,
  phase: 'no_source',
  statusLabel: 'No source',
};

function formatAudioStatus(phase: AudioMonitorWebRtcState): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting';
    case 'monitoring':
      return 'Monitoring';
    case 'muted':
      return 'Muted';
    case 'blocked':
      return 'Blocked';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
    case 'no_source':
    default:
      return 'No source';
  }
}

function deriveAudioMonitorState(
  remote: AudioMonitorState,
  local: {
    joined: boolean;
    locallyMuted: boolean;
    autoplayBlocked: boolean;
    peerState: RTCPeerConnectionState | 'idle' | 'joining';
    localError: string;
  }
): ClientAudioMonitorState {
  let phase: AudioMonitorWebRtcState = remote.webrtcState;

  if (!remote.sourceAvailable) {
    phase = 'no_source';
  } else if (local.localError || remote.lastError) {
    phase = 'error';
  } else if (local.autoplayBlocked) {
    phase = 'blocked';
  } else if (local.joined && (local.peerState === 'joining' || local.peerState === 'new' || local.peerState === 'connecting')) {
    phase = 'connecting';
  } else if (local.joined && local.locallyMuted) {
    phase = 'muted';
  } else if (local.joined && local.peerState === 'connected') {
    phase = 'monitoring';
  } else if (!local.joined && remote.sourceAvailable) {
    phase = 'idle';
  }

  return {
    ...remote,
    autoplayBlocked: local.autoplayBlocked || remote.autoplayBlocked,
    lastError: local.localError || remote.lastError,
    joined: local.joined,
    locallyMuted: local.locallyMuted,
    phase,
    statusLabel: formatAudioStatus(phase),
  };
}

export function useSlate(): SlateState & SlateActions {
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const activeTabRef = useRef<StudioTab>('notes');

  const [socketConnected, setSocketConnected] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [notes, setNotes] = useState<SlateNote[]>([]);
  const [codeText, setCodeText] = useState('');
  const [atemState, setAtemState] = useState<AtemState | null>(DEFAULT_ATEM_STATE);
  const [remoteAudioMonitor, setRemoteAudioMonitor] = useState<AudioMonitorState>(DEFAULT_AUDIO_MONITOR_STATE);
  const [audioJoined, setAudioJoined] = useState(false);
  const [audioLocallyMuted, setAudioLocallyMuted] = useState(true);
  const [audioAutoplayBlocked, setAudioAutoplayBlocked] = useState(false);
  const [audioPeerState, setAudioPeerState] = useState<RTCPeerConnectionState | 'idle' | 'joining'>('idle');
  const [audioLocalError, setAudioLocalError] = useState('');
  const [playbackConnection, setPlaybackConnection] = useState<PlaybackConnectionState | null>(DEFAULT_PLAYBACK_CONNECTION_STATE);
  const [atemToast, setAtemToast] = useState<AtemToast | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [projects, setProjects] = useState<SlateProject[]>([]);

  const pushLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-199), line]);
  }, []);

  const emit = useCallback((event: string, data?: unknown) => {
    socketRef.current?.emit(event, data);
  }, []);

  const ensureAudioElement = useCallback(() => {
    if (audioElementRef.current) return audioElementRef.current;
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', 'true');
    audio.muted = true;
    audioElementRef.current = audio;
    return audio;
  }, []);

  const teardownAudioMonitor = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current = null;
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      (audioElementRef.current as HTMLAudioElement & { srcObject?: MediaStream | null }).srcObject = null;
    }
    setAudioJoined(false);
    setAudioLocallyMuted(true);
    setAudioAutoplayBlocked(false);
    setAudioPeerState('idle');
  }, []);

  const pushMuteState = useCallback((muted: boolean, autoplayBlocked = false) => {
    emit('audioMonitorSetMuted', { muted, autoplayBlocked });
  }, [emit]);

  const attemptPlayback = useCallback(async (muted: boolean) => {
    const audio = ensureAudioElement();
    audio.muted = muted;
    try {
      await audio.play();
      setAudioAutoplayBlocked(false);
      setAudioLocallyMuted(muted);
      setAudioLocalError('');
      pushMuteState(muted, false);
    } catch (error) {
      setAudioAutoplayBlocked(true);
      setAudioLocallyMuted(true);
      pushMuteState(true, true);
      pushLog(`[audio] autoplay blocked: ${(error as Error).message}`);
    }
  }, [ensureAudioElement, pushLog, pushMuteState]);

  const joinAudioMonitor = useCallback(async () => {
    if (audioJoined || activeTabRef.current !== 'audio') return;
    if (!socketRef.current) return;
    if (typeof RTCPeerConnection === 'undefined') {
      setAudioLocalError('This browser does not support WebRTC audio monitoring');
      return;
    }

    teardownAudioMonitor();
    setAudioLocalError('');

    const audio = ensureAudioElement();
    const stream = new MediaStream();
    streamRef.current = stream;
    (audio as HTMLAudioElement & { srcObject?: MediaStream | null }).srcObject = stream;

    const peer = new RTCPeerConnection({ iceServers: [] });
    peerRef.current = peer;
    setAudioJoined(true);
    setAudioPeerState('joining');

    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.ontrack = (event) => {
      const target = streamRef.current ?? stream;
      target.addTrack(event.track);
      void attemptPlayback(false);
    };
    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      emit('audioMonitorSignal', { candidate: event.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      setAudioPeerState(peer.connectionState);
      if (peer.connectionState === 'failed') {
        setAudioLocalError('WebRTC connection failed');
      }
    };

    emit('audioMonitorJoin');
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    emit('audioMonitorSignal', { description: peer.localDescription?.toJSON() ?? offer });
  }, [activeTabRef, attemptPlayback, audioJoined, emit, ensureAudioElement, teardownAudioMonitor]);

  const leaveAudioMonitor = useCallback(() => {
    emit('audioMonitorLeave');
    teardownAudioMonitor();
  }, [emit, teardownAudioMonitor]);

  const setAudioMonitorMuted = useCallback((muted: boolean) => {
    if (muted) {
      const audio = ensureAudioElement();
      audio.muted = true;
      setAudioLocallyMuted(true);
      setAudioAutoplayBlocked(false);
      pushMuteState(true, false);
      return;
    }

    void attemptPlayback(false);
  }, [attemptPlayback, ensureAudioElement, pushMuteState]);

  useEffect(() => {
    const map = (project: { projectId: string; name: string; clientName: string; phase?: string }): SlateProject => ({
      projectId: project.projectId,
      name: project.name,
      clientName: project.clientName,
      phase: project.phase,
    });

    fetch('/api/projects')
      .then((response) => response.ok ? response.json() : { projects: [] })
      .then((data: { projects: SlateProject[] }) => setProjects(data.projects.map(map)))
      .catch(() => {});

    const mainSocket = io('/', { transports: ['websocket'] });
    mainSocket.on('projects:changed', (updated: SlateProject[]) => setProjects(updated.map(map)));
    return () => { mainSocket.disconnect(); };
  }, []);

  useEffect(() => {
    const socket = io('/slate', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
      pushLog(`[socket] connected: ${socket.id}`);
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
      pushLog('[socket] disconnected');
    });

    socket.on('projectLoaded', (data: { projectId: string; notes: SlateNote[] }) => {
      setCurrentProjectId(data.projectId);
      setNotes(data.notes);
      pushLog(`[slate] project loaded: ${data.projectId} (${data.notes.length} notes)`);
    });

    socket.on('noActiveProject', () => {
      setCurrentProjectId(null);
      setNotes([]);
    });

    socket.on('noteAdded', (note: SlateNote) => {
      setNotes((prev) => [...prev, note]);
    });

    socket.on('noteEdited', (data: { index: number; note: SlateNote }) => {
      setNotes((prev) => {
        const next = [...prev];
        next[data.index] = data.note;
        return next;
      });
    });

    socket.on('noteDeleted', (index: number) => {
      setNotes((prev) => prev.filter((_, i) => i !== index));
    });

    socket.on('notesDeleted', (indices: number[]) => {
      const selected = new Set(indices);
      setNotes((prev) => prev.filter((_, i) => !selected.has(i)));
    });

    socket.on('codeUpdate', (value: string) => setCodeText(value));
    socket.on('atemState', (state: AtemState) => setAtemState(state));
    socket.on('audioMonitorState', (state: AudioMonitorState) => setRemoteAudioMonitor(state));
    socket.on('audioMonitorSignal', async (payload: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
      const peer = peerRef.current;
      if (!peer) return;
      if (payload.description) {
        await peer.setRemoteDescription(payload.description);
      }
      if (payload.candidate) {
        await peer.addIceCandidate(payload.candidate);
      }
    });
    socket.on('audioMonitorError', (payload: { message?: string }) => {
      const message = payload.message ?? 'Audio monitor error';
      setAudioLocalError(message);
      pushLog(`[audio] ${message}`);
    });
    socket.on('playbackConnectionState', (state: PlaybackConnectionState) => setPlaybackConnection(state));

    socket.on('atemCommandResult', (result: AtemToast) => {
      setAtemToast(result);
      setTimeout(() => setAtemToast(null), 3500);
    });

    socket.on('log', (line: string) => pushLog(line));

    return () => {
      teardownAudioMonitor();
      socket.disconnect();
    };
  }, [pushLog, teardownAudioMonitor]);

  const audioMonitor = deriveAudioMonitorState(remoteAudioMonitor, {
    joined: audioJoined,
    locallyMuted: audioLocallyMuted,
    autoplayBlocked: audioAutoplayBlocked,
    peerState: audioPeerState,
    localError: audioLocalError,
  });

  return {
    socketConnected,
    currentProjectId,
    notes,
    codeText,
    atemState,
    audioMonitor,
    playbackConnection,
    atemToast,
    logs,
    projects,

    loadProject: (id) => {
      emit('loadProject', id);
      // Auto-advance pre_production → production when a project is opened in Slate.
      const project = projects.find((p) => p.projectId === id);
      if (project?.phase === 'pre_production') {
        void fetch(`/api/projects/${id}/phase`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phase: 'production', subPhase: 'recording' }),
        });
      }
    },
    addNote: (code, note) => emit('addNote', { code, note }),
    editNote: (index, code, note) => emit('editNote', { index, code, note }),
    deleteNote: (index) => emit('deleteNote', index),
    deleteNotes: (indices) => emit('deleteNotes', indices),
    updateCode: (value) => { setCodeText(value); emit('codeUpdate', value); },
    atemConnect: (ip) => emit('atemConnect', { ipAddress: ip }),
    atemDisconnect: () => emit('atemDisconnect'),
    atemSetPreview: (id) => emit('atemSetPreview', { inputId: id }),
    atemSetProgram: (id) => emit('atemSetProgram', { inputId: id }),
    atemCut: () => emit('atemCut'),
    atemAuto: () => emit('atemAuto'),
    atemStartRecording: (filename) => emit('atemStartRecording', filename ? { filename } : undefined),
    atemStopRecording: () => emit('atemStopRecording'),
    atemSetFilename: (filename) => emit('atemSetFilename', { filename }),
    atemSetOutput4Mode: (mode) => emit('atemSetOutput4Mode', { mode }),
    setStudioTab: (tab) => {
      activeTabRef.current = tab;
      if (tab === 'audio') {
        void joinAudioMonitor();
      } else if (audioJoined) {
        leaveAudioMonitor();
      }
    },
    joinAudioMonitor: () => { void joinAudioMonitor(); },
    leaveAudioMonitor,
    setAudioMonitorMuted,
    setAudioMonitorInput: (input) => emit('audioMonitorSetInput', input
      ? { deviceKey: input.deviceKey, label: input.label }
      : { deviceKey: '', label: '' }),
    dismissToast: () => setAtemToast(null),
  };
}
