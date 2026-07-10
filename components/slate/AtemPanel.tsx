'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { AtemState } from '@/lib/services/atem-utils';
import type { TravelModeState } from '@/hooks/useSlate';
import type { SonyCameraDevice } from '@/lib/store/studio-config-store';
import type { DiscoveredCamera, CameraHealth } from '@/lib/services/camera-control-service';

function newCameraId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `cam-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const TRAVEL_ATEM_IP = '10.10.10.241';
const HOME_ATEM_IP = '172.20.10.241';
const TRAVEL_BRIDGE_URL = 'http://100.110.17.100:4011';

type SettingsTab = 'travel' | 'file' | 'cameras';
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: 'travel',  label: 'Travel' },
  { id: 'file',    label: 'File' },
  { id: 'cameras', label: 'Cameras' },
];

interface Props {
  atemState: AtemState | null;
  travelMode: TravelModeState;
  atemPaused: boolean;
  settingsOpen: boolean;
  onSettingsToggle: () => void;
  onConnect: (ip: string) => void;
  onDisconnect: () => void;
  onEnableTravelMode: (bridgeUrl: string, atemIp: string) => void;
  onDisableTravelMode: (atemIp: string) => void;
  onPause: () => void;
  onResume: () => void;
  onSetFilename: (filename: string) => void;
  onSetPreview: (inputId: number) => void;
  onSetProgram: (inputId: number) => void;
  onStartRecording: (filename?: string) => void;
  onStopRecording: () => void;
  onOutput4Toggle: () => void;
  output4Mode: 'multiview' | 'program';
  /** Live liveness for rostered cameras; drives the per-row status dots. */
  cameraHealth?: CameraHealth[];
  /** Result of the last camera timecode soft-jam (for the Sync TC readout). */
  cameraTimecode?: { timecode: string; jammedAt: string; results: Array<{ id: string; label: string; ok: boolean; timecode?: string; error?: string }> } | null;
  onSyncTimecode?: () => void;
}

const CAMERAS = [1, 2, 3, 4, 5, 6];

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 0 1 1.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 0 1-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 0 1-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 0 1-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 0 1 .7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z"/>
      <circle cx="12" cy="12" r="3.4"/>
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M1 1l12 12M13 1L1 13"/>
    </svg>
  );
}

export function AtemPanel({
  atemState,
  travelMode,
  atemPaused,
  settingsOpen,
  onSettingsToggle,
  onConnect,
  onDisconnect,
  onEnableTravelMode,
  onDisableTravelMode,
  onPause,
  onResume,
  onSetFilename,
  onSetPreview,
  onSetProgram,
  onOutput4Toggle,
  output4Mode,
  cameraHealth = [],
  cameraTimecode = null,
  onSyncTimecode,
}: Readonly<Props>) {
  const [ipInput, setIpInput] = useState(atemState?.switcherIp ?? '');
  const [filenameInput, setFilenameInput] = useState(atemState?.recording.filename ?? '');
  const [showChecklist, setShowChecklist] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('travel');

  // ── Sony camera roster (armed cams follow the studio REC button) ──
  const [cameras, setCameras] = useState<SonyCameraDevice[]>([]);
  const [camEnabled, setCamEnabled] = useState(true);
  const [camSaving, setCamSaving] = useState(false);
  const [camMsg, setCamMsg] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredCamera[]>([]);

  // Load the roster whenever the settings sheet opens.
  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    fetch('/api/studio/camera/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { camera?: { cameras?: SonyCameraDevice[]; enabled?: boolean } } | null) => {
        if (cancelled) return;
        setCameras(Array.isArray(data?.camera?.cameras) ? data!.camera!.cameras! : []);
        setCamEnabled(data?.camera?.enabled !== false);
      })
      .catch(() => { /* leave roster empty on failure */ });
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Master switch — persists immediately (independent of the roster's Save button).
  async function toggleCamerasEnabled() {
    const next = !camEnabled;
    setCamEnabled(next);
    try {
      await fetch('/api/studio/camera/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera: { enabled: next } }),
      });
    } catch {
      setCamEnabled(!next);   // roll back on failure
    }
  }

  function updateCamera(id: string, patch: Partial<SonyCameraDevice>) {
    setCameras((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function addCamera() {
    setCameras((prev) => [
      ...prev,
      { id: newCameraId(), label: `Cam ${prev.length + 1}`, host: '', model: 'fx6', armed: false },
    ]);
  }
  function removeCamera(id: string) {
    setCameras((prev) => prev.filter((c) => c.id !== id));
  }
  // Ask the Sony SDK to scan the network and list the cameras it finds (name +
  // model + IP) so the operator doesn't have to hunt for IP addresses.
  async function scanForCameras() {
    setScanning(true);
    setScanErr('');
    try {
      const res = await fetch('/api/studio/camera/discover');
      const body = await res.json() as { cameras?: DiscoveredCamera[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Scan failed');
      const found = body.cameras ?? [];
      setDiscovered(found);
      if (found.length === 0) setScanErr('No cameras found. Check they are on the same network and powered on.');
    } catch (err) {
      setScanErr((err as Error).message);
      setDiscovered([]);
    } finally {
      setScanning(false);
    }
  }
  // Add a scanned camera into the roster (armed by default), de-duped by IP.
  // The MAC is kept so a changed DHCP address can be recovered automatically.
  function addDiscovered(cam: DiscoveredCamera) {
    setCameras((prev) => {
      if (prev.some((c) => c.host === cam.host)) return prev;
      return [...prev, {
        id: newCameraId(),
        label: cam.name || cam.model.toUpperCase() || `Cam ${prev.length + 1}`,
        host: cam.host,
        model: cam.model === 'fx3' ? 'fx3' : 'fx6',
        armed: true,
        ...(cam.macAddress ? { mac: cam.macAddress.toUpperCase() } : {}),
      }];
    });
  }
  async function saveCameras() {
    setCamSaving(true);
    setCamMsg('');
    try {
      const res = await fetch('/api/studio/camera/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera: { cameras } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { camera?: { cameras?: SonyCameraDevice[] } };
      setCameras(Array.isArray(data?.camera?.cameras) ? data.camera!.cameras! : cameras);
      setCamMsg('Saved');
    } catch (err) {
      setCamMsg(`Save failed: ${(err as Error).message}`);
    } finally {
      setCamSaving(false);
    }
  }

  useEffect(() => {
    setFilenameInput(atemState?.recording.filename ?? '');
  }, [atemState?.recording.filename]);

  // Close the settings sheet on Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onSettingsToggle(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsOpen, onSettingsToggle]);

  const connected = atemState?.connected ?? false;
  const isRecording = atemState?.recording.isRecording ?? false;
  const previewInput = atemState?.previewInput ?? null;
  const programInput = atemState?.programInput ?? null;
  const switcherIp = atemState?.switcherIp ?? '';
  const recordingFilename = atemState?.recording.filename ?? '';
  const output4IsProgram = output4Mode === 'program';

  const handleTravelToggle = () => {
    if (travelMode.active) {
      onDisableTravelMode(HOME_ATEM_IP);
      setShowChecklist(false);
    } else {
      onEnableTravelMode(TRAVEL_BRIDGE_URL, TRAVEL_ATEM_IP);
    }
  };

  const connectionText = connected
    ? `${travelMode.active ? '✈ ' : ''}Connected · ${switcherIp}`
    : (atemState?.bridgeAvailable ? 'Bridge ready · not connected' : 'Bridge unavailable');

  return (
    <div className="at-panel">

      {/* ── Header (unified studio header: title + gear, status on the subline) ── */}
      <div className="st-head">
        <span className="st-head-title">ATEM</span>
        <button className="at-gear" type="button" onClick={onSettingsToggle} aria-label="ATEM settings">
          <GearIcon />
        </button>
      </div>
      <div className="at-subline">
        <span>{connectionText}</span>
        {isRecording && <span className="at-rec"><span className="at-rec-dot" />REC</span>}
      </div>

      {/* ── Program bus (tap = on air) ── */}
      <div className="at-bus">
        <p className="at-bus-label at-bus-label--pgm">● Program</p>
        <div className="at-grid">
          {CAMERAS.map((cam) => (
            <button
              key={cam}
              type="button"
              className={`at-cam${programInput === cam ? ' at-cam--pgm-on' : ''}`}
              onClick={() => onSetProgram(cam)}
              aria-pressed={programInput === cam}
            >
              <span className="at-cam-live">LIVE</span>
              <span className="at-cam-n">Cam {cam}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Preview bus (tap = cue) ── */}
      <div className="at-bus">
        <p className="at-bus-label at-bus-label--pvw">● Preview</p>
        <div className="at-grid">
          {CAMERAS.map((cam) => (
            <button
              key={cam}
              type="button"
              className={`at-cam${previewInput === cam ? ' at-cam--pvw-on' : ''}`}
              onClick={() => onSetPreview(cam)}
              aria-pressed={previewInput === cam}
            >
              <span className="at-cam-live">CUE</span>
              <span className="at-cam-n">Cam {cam}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Output 4 mode ── */}
      <div className="at-foot">
        <button
          type="button"
          className={`at-out4${output4IsProgram ? ' at-out4--pgm' : ''}`}
          onClick={onOutput4Toggle}
          title="Output 4 source — tap to switch"
        >
          {output4IsProgram ? 'Program' : 'Multiview'}
        </button>
      </div>

      <div className={`at-status${isRecording ? ' at-status--rec' : ''}`}>
        {atemPaused ? 'Reconnect paused' : `Record file: ${recordingFilename || '—'}`}
      </div>

      {/* ── Settings sheet ── */}
      {settingsOpen && createPortal(
        <div className="at-backdrop" onClick={onSettingsToggle}>
          <div className="at-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="ATEM settings">
            <div className="at-sheet-head">
              <h3>ATEM settings</h3>
              <button className="at-sheet-close" type="button" onClick={onSettingsToggle} aria-label="Close"><CloseIcon /></button>
            </div>

            <div className="at-tabs" role="tablist" aria-label="ATEM settings sections">
              {SETTINGS_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`at-tab-${tab.id}`}
                  aria-selected={settingsTab === tab.id}
                  aria-controls={`at-tabpanel-${tab.id}`}
                  className={`at-tab${settingsTab === tab.id ? ' at-tab--on' : ''}`}
                  onClick={() => setSettingsTab(tab.id)}
                >{tab.label}</button>
              ))}
            </div>

            {settingsTab === 'travel' && (
            <div className="at-tabpanel" role="tabpanel" id="at-tabpanel-travel" aria-labelledby="at-tab-travel">
            {/* Travel mode */}
            <div className="at-set-row">
              <div className="at-set-label">
                <div className="t">Travel mode</div>
                <div className="s">Route through the remote bridge over Tailscale</div>
              </div>
              <button
                type="button"
                className={`at-sw${travelMode.active ? ' at-sw--on' : ''}`}
                onClick={handleTravelToggle}
                aria-pressed={travelMode.active}
                aria-label="Travel mode"
              ><span /></button>
              <button
                type="button"
                className="at-help"
                onClick={() => setShowChecklist((v) => !v)}
                aria-label="Setup checklist"
              >?</button>
            </div>
            {showChecklist && (
              <ol className="at-checklist">
                <li>Ethernet cable from ATEM → Mac USB adapter</li>
                <li>Mac Network → USB LAN → Manual IP <code>10.10.10.1</code>, mask <code>255.255.255.0</code></li>
                <li>ATEM Network → Static <code>10.10.10.241</code>, gateway <code>10.10.10.1</code></li>
                <li>Double-click <strong>Start ATEM Bridge</strong> on Mac desktop</li>
                <li>Mac connected to venue WiFi — Tailscale icon is green</li>
                <li>Flip the toggle</li>
              </ol>
            )}

            {/* Pause reconnect */}
            <div className="at-set-row">
              <div className="at-set-label">
                <div className="t">Pause reconnect</div>
                <div className="s">Stop auto-reconnect attempts (bridge stays up)</div>
              </div>
              <button
                type="button"
                className={`at-sw${atemPaused ? ' at-sw--on' : ''}`}
                onClick={() => (atemPaused ? onResume() : onPause())}
                aria-pressed={atemPaused}
                aria-label="Pause reconnect"
              ><span /></button>
            </div>

            {/* Connection */}
            <div className="at-set-block">
              <div className="at-set-label">
                <div className="t">Connection</div>
                <div className="s">ATEM IP address</div>
              </div>
              <input
                className="at-input"
                placeholder="172.20.10.241"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onConnect(ipInput); }}
              />
              <div className="at-set-btns">
                <button type="button" className="at-btn at-btn--pri" onClick={() => onConnect(ipInput)}>Connect</button>
                <button type="button" className="at-btn" onClick={onDisconnect} disabled={!connected}>Disconnect</button>
              </div>
            </div>
            </div>
            )}

            {settingsTab === 'file' && (
            <div className="at-tabpanel" role="tabpanel" id="at-tabpanel-file" aria-labelledby="at-tab-file">
            {/* Record filename */}
            <div className="at-set-block">
              <div className="at-set-label">
                <div className="t">Record filename</div>
                <div className="s">Base name for ATEM recordings</div>
              </div>
              <input
                className="at-input"
                placeholder="session name"
                value={filenameInput || recordingFilename}
                onChange={(e) => setFilenameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onSetFilename(filenameInput); }}
              />
              <div className="at-set-btns">
                <button type="button" className="at-btn at-btn--pri" onClick={() => onSetFilename(filenameInput)}>Apply</button>
              </div>
            </div>
            </div>
            )}

            {settingsTab === 'cameras' && (
            <div className="at-tabpanel" role="tabpanel" id="at-tabpanel-cameras" aria-labelledby="at-tab-cameras">
            {/* Master switch — turn the whole camera tier off when cameras are stored away */}
            <div className="at-set-row">
              <div className="at-set-label">
                <div className="t">Camera control</div>
                <div className="s">Enable/Disable connection to Sony cameras.</div>
              </div>
              <button
                type="button"
                className={`at-sw${camEnabled ? ' at-sw--on' : ''}`}
                onClick={() => void toggleCamerasEnabled()}
                aria-pressed={camEnabled}
                aria-label="Camera control"
              ><span /></button>
            </div>

            {/* Timecode soft-jam — set all armed cameras to LPOS wall-clock (between takes) */}
            <div className="at-set-block" style={camEnabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
              <div className="at-set-label">
                <div className="t">Timecode sync</div>
                <div className="s">Jam armed cameras to LPOS time-of-day (Free-Run). Software only — accurate to the network, not frame-locked. Run between takes, not while recording.</div>
              </div>
              <div className="at-set-btns">
                <button type="button" className="at-btn at-btn--pri" onClick={() => onSyncTimecode?.()}>Sync timecode</button>
              </div>
              {cameraTimecode && (
                <div className="at-tc-readout">
                  <span className="at-tc-value">{cameraTimecode.timecode}</span>
                  {cameraTimecode.results.map((r) => (
                    <span key={r.id} className={`at-tc-chip${r.ok ? ' at-tc-chip--ok' : ' at-tc-chip--fail'}`}
                      title={r.ok ? (r.timecode ?? '') : (r.error ?? 'failed')}>
                      {r.label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Sony cameras — armed cams start/stop with the studio REC button */}
            <div className="at-set-block" style={camEnabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
              <div className="at-set-label">
                <div className="t">Sony cameras</div>
                <div className="s">Connect to and arm Sony cameras over the network.</div>
              </div>

              {cameras.length === 0 && (
                <p className="at-cam-empty">No cameras yet. Add one to sync it with REC.</p>
              )}

              {cameras.map((cam) => {
                const health = cameraHealth.find((h) => h.id === cam.id);
                // `online` is only a TCP probe on :80. A camera can answer that and still
                // reject the SDK session (wrong Access Auth password, held by another
                // controller) — that lands in health.error. Showing those as plain "Online"
                // is what made a failed REC look like a broken camera rather than bad creds.
                const dot = !health ? 'unknown'
                  : !health.online ? 'offline'
                  : health.error ? 'error'
                  : health.recording ? 'recording'
                  : 'online';
                const dotTitle = !health
                  ? 'Not checked yet — save to start monitoring'
                  : !health.online ? `Offline (${cam.host})`
                  : health.error ? `Reachable but SDK error (${cam.host}): ${health.error}`
                  : health.recording ? `Recording (${cam.host})`
                  : `Online (${cam.host})`;
                return (
                <div className="at-cam-row" key={cam.id}>
                  <span className={`at-cam-dot at-cam-dot--${dot}`} title={dotTitle} aria-label={dotTitle} />
                  <button
                    type="button"
                    className={`at-sw at-sw--sm${cam.armed ? ' at-sw--on' : ''}`}
                    onClick={() => updateCamera(cam.id, { armed: !cam.armed })}
                    aria-pressed={cam.armed}
                    aria-label={`Arm ${cam.label || 'camera'}`}
                  ><span /></button>
                  <input
                    className="at-input at-cam-label"
                    placeholder="Label"
                    value={cam.label}
                    onChange={(e) => updateCamera(cam.id, { label: e.target.value })}
                  />
                  <input
                    className="at-input at-cam-host"
                    placeholder="192.168.0.10"
                    value={cam.host}
                    onChange={(e) => updateCamera(cam.id, { host: e.target.value })}
                  />
                  <select
                    className="at-input at-cam-model"
                    value={cam.model}
                    onChange={(e) => updateCamera(cam.id, { model: e.target.value === 'fx3' ? 'fx3' : 'fx6' })}
                  >
                    <option value="fx6">FX6</option>
                    <option value="fx3">FX3</option>
                  </select>
                  <button
                    type="button"
                    className="at-cam-del"
                    onClick={() => removeCamera(cam.id)}
                    aria-label={`Remove ${cam.label || 'camera'}`}
                  ><CloseIcon /></button>
                </div>
                );
              })}

              <div className="at-set-btns">
                <button type="button" className="at-btn" onClick={scanForCameras} disabled={scanning}>
                  {scanning ? 'Scanning…' : 'Scan network'}
                </button>
                <button type="button" className="at-btn" onClick={addCamera}>Add manually</button>
                <button type="button" className="at-btn at-btn--pri" onClick={saveCameras} disabled={camSaving}>
                  {camSaving ? 'Saving…' : 'Save cameras'}
                </button>
              </div>
              {camMsg && <span className="at-cam-msg">{camMsg}</span>}

              {/* Scan results — pick a camera to drop it into the roster */}
              {scanErr && <p className="at-error">{scanErr}</p>}
              {discovered.length > 0 && (
                <div className="at-scan-list">
                  <div className="at-scan-head">Found {discovered.length} camera{discovered.length > 1 ? 's' : ''}</div>
                  {discovered.map((cam) => {
                    const already = cameras.some((c) => c.host === cam.host);
                    return (
                      <div className="at-scan-row" key={cam.id || cam.host}>
                        <div className="at-scan-info">
                          <span className="at-scan-name">{cam.name || cam.model.toUpperCase()}</span>
                          <span className="at-scan-meta">{cam.model.toUpperCase()} · {cam.host}</span>
                        </div>
                        <button
                          type="button"
                          className="at-btn at-scan-add"
                          onClick={() => addDiscovered(cam)}
                          disabled={already}
                        >{already ? 'Added' : 'Add'}</button>
                      </div>
                    );
                  })}
                  <div className="at-scan-hint">Added cameras still need <strong>Save cameras</strong> to persist.</div>
                </div>
              )}
            </div>
            </div>
            )}

            {/* Connection errors are surfaced regardless of the active tab. */}
            {atemState?.lastError && <p className="at-error">{atemState.lastError}</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
