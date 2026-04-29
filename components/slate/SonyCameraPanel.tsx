'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { CameraStatus, DiscoveredCamera } from '@/lib/services/camera-control-service';
import type { CameraConfig } from '@/lib/store/studio-config-store';

const POLL_INTERVAL_MS = 2_500;

function formatRemaining(seconds: number | null): string {
  if (seconds === null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function friendlyWb(mode: string | null): string {
  if (!mode) return '—';
  const map: Record<string, string> = {
    Auto: 'Auto', Daylight: 'Daylight', Shade: 'Shade', Cloudy: 'Cloudy',
    Incandescent: 'Tungsten', Fluorescent: 'Fluorescent', Flash: 'Flash',
    Manual1: 'Custom 1', Manual2: 'Custom 2', Manual3: 'Custom 3',
    Color_Temperature: 'Color Temp',
  };
  return map[mode] ?? mode;
}

function formatConnectionError(message: string): string {
  return message
    .replace('fetch failed', 'Could not reach camera')
    .replace('Camera host not configured', 'Scan and select a camera first');
}

function cameraLabel(camera: DiscoveredCamera): string {
  const name = camera.name?.trim() || camera.model.toUpperCase();
  return `${name} (${camera.host})`;
}

export function SonyCameraPanel() {
  const [availableCameras, setAvailableCameras] = useState<DiscoveredCamera[]>([]);
  const [selectedHost, setSelectedHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [scanning, setScanning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [wbOptions, setWbOptions] = useState<string[]>([]);
  const [isoOptions, setIsoOptions] = useState<string[]>([]);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const [liveviewSrc, setLiveviewSrc] = useState<string | null>(null);
  const [feedError, setFeedError] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedCamera = availableCameras.find((c) => c.host === selectedHost) ?? null;

  const scanCameras = useCallback(async (preferredHost?: string) => {
    setScanning(true);
    setConnError(null);
    try {
      const res = await fetch('/api/studio/camera/discover');
      const body = await res.json() as { cameras?: DiscoveredCamera[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Camera scan failed');
      const cameras = body.cameras ?? [];
      setAvailableCameras(cameras);
      setSelectedHost((current) => {
        if (preferredHost && cameras.some((c) => c.host === preferredHost)) return preferredHost;
        if (current && cameras.some((c) => c.host === current)) return current;
        return cameras[0]?.host ?? '';
      });
    } catch (err) {
      setConnError(formatConnectionError((err as Error).message));
      setAvailableCameras([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/studio/camera/config');
        if (!res.ok) return;
        const data = await res.json() as { camera?: Partial<CameraConfig> };
        const camera = data.camera;
        if (!camera) return;
        if (camera.host ?? camera.ip) setSelectedHost((camera.host ?? camera.ip ?? '') as string);
        if (camera.username) setUsername(camera.username);
        if (camera.password) setPassword(camera.password);
        if (camera.fingerprint) setFingerprint(camera.fingerprint);
        await scanCameras((camera.host ?? camera.ip ?? '') as string | undefined);
      } catch { /* ignore */ }
    })();
  }, [scanCameras]);

  const rpc = useCallback(async (method: string, params?: unknown[]) => {
    const res = await fetch('/api/studio/camera/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params, host: selectedHost }),
    });
    return res.json() as Promise<Record<string, unknown>>;
  }, [selectedHost]);

  const persistConfig = useCallback(async () => {
    await fetch('/api/studio/camera/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        camera: {
          provider: 'sony-sdk',
          model: selectedCamera?.model ?? 'fx6',
          host: selectedHost, ip: selectedHost,
          port: 10000, username, password, fingerprint,
        },
      }),
    });
  }, [selectedCamera?.model, selectedHost, username, password, fingerprint]);

  const pollStatus = useCallback(async () => {
    try {
      const res = await rpc('getEvent');
      if (res.result) setStatus(res.result as CameraStatus);
    } catch { /* ignore */ }
  }, [rpc]);

  function startPolling() {
    stopPolling();
    void pollStatus();
    pollTimer.current = setInterval(() => void pollStatus(), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
  }

  useEffect(() => () => stopPolling(), []);

  async function handleConnect() {
    setConnecting(true); setConnError(null); setActionErr(null);
    try {
      await persistConfig();
      const apiRes = await rpc('getAvailableApiList');
      if (apiRes.error) throw new Error(String(apiRes.error));
      const apis = (apiRes.result as string[] | undefined) ?? [];
      const [wbRes, isoRes, statusRes] = await Promise.all([
        apis.includes('getAvailableWhiteBalance') ? rpc('getAvailableWhiteBalance') : Promise.resolve(null),
        apis.includes('getAvailableIsoSpeedRate') ? rpc('getAvailableIsoSpeedRate') : Promise.resolve(null),
        rpc('getEvent'),
      ]);
      if (wbRes?.result) setWbOptions(wbRes.result as string[]);
      if (isoRes?.result) setIsoOptions(isoRes.result as string[]);
      if (statusRes.result) setStatus(statusRes.result as CameraStatus);
      setConnected(true); setFeedError(false);
      setLiveviewSrc(`/api/studio/camera/liveview?host=${encodeURIComponent(selectedHost)}&t=${Date.now()}`);
      startPolling();
    } catch (err) {
      setConnError(formatConnectionError((err as Error).message));
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    stopPolling(); setConnected(false); setLiveviewSrc(null);
    setStatus(null); setWbOptions([]); setIsoOptions([]);
  }

  async function handleRecord(start: boolean) {
    setActionErr(null);
    try {
      const res = await rpc(start ? 'startMovieRec' : 'stopMovieRec');
      if (res.error) throw new Error(String(res.error));
      await pollStatus();
    } catch (err) { setActionErr((err as Error).message); }
  }

  async function handleSetWb(modeValue: string) {
    try {
      const res = await rpc('setWhiteBalance', [modeValue]);
      if (res.error) throw new Error(String(res.error));
      await pollStatus();
    } catch (err) { setActionErr((err as Error).message); }
  }

  async function handleSetIso(isoValue: string) {
    try {
      const res = await rpc('setIsoSpeedRate', [isoValue]);
      if (res.error) throw new Error(String(res.error));
      await pollStatus();
    } catch (err) { setActionErr((err as Error).message); }
  }

  const isRecording = status?.recording ?? false;

  return (
    <div style={{ display: 'contents' }}>
      <div className="cam-connect-bar">
        <button type="button" className="cam-btn cam-btn--connect"
          onClick={() => void scanCameras(selectedHost || undefined)}
          disabled={scanning || connecting}>
          {scanning ? 'Scanning…' : 'Scan Cameras'}
        </button>
        <select className="cam-ip-input" value={selectedHost}
          onChange={(e) => setSelectedHost(e.target.value)}
          disabled={connected || connecting || scanning || availableCameras.length === 0}
          aria-label="Detected Sony camera">
          <option value="">{availableCameras.length > 0 ? 'Select camera' : 'No cameras found yet'}</option>
          {availableCameras.map((c) => (
            <option key={`${c.host}-${c.id}`} value={c.host}>{cameraLabel(c)}</option>
          ))}
        </select>
        {connected ? (
          <button type="button" className="cam-btn cam-btn--disconnect" onClick={handleDisconnect}>Disconnect</button>
        ) : (
          <button type="button" className="cam-btn cam-btn--connect"
            onClick={() => void handleConnect()} disabled={connecting || !selectedHost}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <span className={`cam-status-dot${connected ? ' cam-status-dot--on' : ''}`} title={connected ? 'Connected' : 'Disconnected'} />
      </div>

      {selectedCamera && (
        <>
          <div className="cam-settings-row cam-settings-row--auth">
            <div className="cam-setting">
              <span className="cam-setting-label">User</span>
              <input className="cam-select" value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="admin" disabled={connected || connecting} />
            </div>
            <div className="cam-setting">
              <span className="cam-setting-label">Pass</span>
              <input className="cam-select" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Camera password" type="password" disabled={connected || connecting} />
            </div>
          </div>
          <div className="cam-setting cam-setting--stack">
            <span className="cam-setting-label">Fingerprint</span>
            <input className="cam-select" value={fingerprint} onChange={(e) => setFingerprint(e.target.value)}
              placeholder="Paste the camera fingerprint shown in Access Authentication"
              disabled={connected || connecting} />
          </div>
        </>
      )}

      <p className="cam-stat cam-stat--status">
        {selectedCamera
          ? `Selected ${selectedCamera.model.toUpperCase()} at ${selectedCamera.host}${selectedCamera.sshSupported ? ' with secure auth available.' : '.'}`
          : 'Scan for Sony cameras on the network, then select one to connect.'}
      </p>

      {connError && <p className="cam-error">{connError}</p>}

      <div className="cam-monitor-wrap">
        {liveviewSrc && !feedError ? (
          <img className="cam-monitor" src={liveviewSrc} alt="Camera liveview" onError={() => setFeedError(true)} />
        ) : (
          <div className="cam-monitor-placeholder">
            {connected && feedError ? (
              <>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <span>Feed unavailable</span>
                <button type="button" className="cam-btn cam-btn--sm" onClick={() => {
                  setFeedError(false);
                  setLiveviewSrc(`/api/studio/camera/liveview?host=${encodeURIComponent(selectedHost)}&t=${Date.now()}`);
                }}>Retry</button>
              </>
            ) : (
              <>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
                <span>{connected ? 'Starting feed…' : 'Scan and connect to a camera'}</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="cam-status-bar">
        <span className={`cam-rec-indicator${isRecording ? ' cam-rec-indicator--on' : ''}`}>
          ● {isRecording ? 'REC' : 'IDLE'}
        </span>
        {status?.batteryPercent !== null && (
          <span className="cam-stat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7" width="18" height="11" rx="2" /><path d="M22 11v3" />
            </svg>
            {status?.batteryPercent ?? '—'}%
          </span>
        )}
        {status?.remainingSeconds !== null && (
          <span className="cam-stat">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            {formatRemaining(status?.remainingSeconds ?? null)}
          </span>
        )}
        {status?.cameraStatus && status.cameraStatus !== 'IDLE' && (
          <span className="cam-stat cam-stat--status">{status.cameraStatus}</span>
        )}
      </div>

      <div className="cam-controls">
        <button type="button"
          className={`cam-rec-btn${isRecording ? '' : ' cam-rec-btn--start'}`}
          onClick={() => void handleRecord(!isRecording)} disabled={!connected}>
          {isRecording ? (
            <><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" /></svg> Stop Recording</>
          ) : (
            <><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /></svg> Start Recording</>
          )}
        </button>
        {actionErr && <p className="cam-error cam-error--inline">{actionErr}</p>}
      </div>

      {connected && (wbOptions.length > 0 || isoOptions.length > 0) && (
        <div className="cam-settings-row">
          {wbOptions.length > 0 && (
            <div className="cam-setting">
              <span className="cam-setting-label">WB</span>
              <select className="cam-select" value={status?.whiteBalance ?? ''} onChange={(e) => void handleSetWb(e.target.value)}>
                <option value="" disabled>—</option>
                {wbOptions.map((wb) => <option key={wb} value={wb}>{friendlyWb(wb)}</option>)}
              </select>
            </div>
          )}
          {isoOptions.length > 0 && (
            <div className="cam-setting">
              <span className="cam-setting-label">ISO</span>
              <select className="cam-select" value={status?.isoSpeedRate ?? ''} onChange={(e) => void handleSetIso(e.target.value)}>
                <option value="" disabled>—</option>
                {isoOptions.map((iso) => <option key={iso} value={iso}>{iso}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
