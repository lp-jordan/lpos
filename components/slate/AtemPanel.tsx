'use client';

import { useState, useEffect } from 'react';
import type { AtemState } from '@/lib/services/atem-utils';
import type { TravelModeState } from '@/hooks/useSlate';

const TRAVEL_ATEM_IP = '10.10.10.241';
const HOME_ATEM_IP = '172.20.10.241';
const TRAVEL_BRIDGE_URL = 'http://100.110.17.100:4011';

interface Props {
  atemState: AtemState | null;
  travelMode: TravelModeState;
  settingsOpen: boolean;
  onSettingsToggle: () => void;
  onConnect: (ip: string) => void;
  onDisconnect: () => void;
  onEnableTravelMode: (bridgeUrl: string, atemIp: string) => void;
  onDisableTravelMode: (atemIp: string) => void;
  onSetFilename: (filename: string) => void;
  onSetPreview: (inputId: number) => void;
  onSetProgram: (inputId: number) => void;
  onCut: () => void;
  onAuto: () => void;
  onStartRecording: (filename?: string) => void;
  onStopRecording: () => void;
  onOutput4Toggle: () => void;
  output4Mode: 'multiview' | 'program';
}

const CAMERAS = [1, 2, 3, 4, 5, 6];

export function AtemPanel({
  atemState,
  travelMode,
  settingsOpen,
  onSettingsToggle,
  onConnect,
  onDisconnect,
  onEnableTravelMode,
  onDisableTravelMode,
  onSetFilename,
  onSetPreview,
  onSetProgram,
  onCut,
  onAuto,
  onStartRecording,
  onStopRecording,
  onOutput4Toggle,
  output4Mode,
}: Readonly<Props>) {
  const [ipInput, setIpInput] = useState(atemState?.switcherIp ?? '');
  const [filenameInput, setFilenameInput] = useState(atemState?.recording.filename ?? '');
  const [showChecklist, setShowChecklist] = useState(false);

  useEffect(() => {
    setFilenameInput(atemState?.recording.filename ?? '');
  }, [atemState?.recording.filename]);

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

  return (
    <div className="sl-atem-panel">
      <div className="sl-atem-header">
        <span className="sl-atem-title">ATEM Control Panel</span>
        <button
          className={`sl-gear-btn${settingsOpen ? ' sl-gear-btn--open' : ''}`}
          onClick={onSettingsToggle}
          type="button"
          aria-label="Toggle ATEM settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>

      {settingsOpen && (
        <div className="sl-atem-settings">

          {/* Travel Mode */}
          <div className="sl-settings-block">
            <div className="sl-travel-row">
              <span className="sl-settings-label">Travel Mode</span>
              <button
                className={`sl-pill-toggle${travelMode.active ? ' sl-pill-toggle--on' : ''}`}
                type="button"
                onClick={handleTravelToggle}
                aria-pressed={travelMode.active}
              >
                <span className="sl-pill-knob" />
              </button>
              <button
                className={`sl-checklist-btn${showChecklist ? ' sl-checklist-btn--active' : ''}`}
                type="button"
                onClick={() => setShowChecklist((v) => !v)}
                aria-label="Show setup checklist"
              >
                ?
              </button>
            </div>

            {showChecklist && (
              <ol className="sl-travel-checklist">
                <li>Ethernet cable from ATEM → Mac USB adapter</li>
                <li>Mac Network → USB LAN → Manual IP <code>10.10.10.1</code>, mask <code>255.255.255.0</code></li>
                <li>ATEM Network → Static <code>10.10.10.241</code>, gateway <code>10.10.10.1</code></li>
                <li>Double-click <strong>Start ATEM Bridge</strong> on Mac desktop</li>
                <li>Mac connected to venue WiFi — Tailscale icon is green</li>
                <li>Flip the toggle</li>
              </ol>
            )}

          </div>

          {/* Connection */}
          <div className="sl-settings-block">
            <span className="sl-settings-label">Connection</span>
            <div className="sl-settings-row">
              <input
                className="sl-input"
                placeholder="ATEM IP Address"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onConnect(ipInput)}
              />
              <button className="sl-btn-sm" type="button" onClick={() => onConnect(ipInput)}>Connect</button>
              <button className="sl-btn-sm" type="button" onClick={onDisconnect} disabled={!connected}>Disconnect</button>
            </div>
          </div>

          {/* Record Filename */}
          <div className="sl-settings-block">
            <span className="sl-settings-label">Record Filename</span>
            <div className="sl-settings-row">
              <input
                className="sl-input"
                placeholder="Recording filename base"
                value={filenameInput || recordingFilename}
                onChange={(e) => setFilenameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSetFilename(filenameInput)}
              />
              <button className="sl-btn-sm" type="button" onClick={() => onSetFilename(filenameInput)}>Apply</button>
            </div>
          </div>

          {atemState?.lastError && (
            <p className="sl-atem-error">{atemState.lastError}</p>
          )}
        </div>
      )}

      <div className="sl-switcher-card">
        <div className="sl-camera-stack">
          <div className="sl-camera-row">
            <span className="sl-camera-row-label">Preview</span>
            <div className="sl-camera-row-buttons">
              {CAMERAS.map((cam) => (
                <button
                  key={cam}
                  className={`sl-cam-btn sl-cam-btn--pvw${previewInput === cam ? ' active' : ''}`}
                  onClick={() => onSetPreview(cam)}
                  type="button"
                >
                  Cam {cam}
                </button>
              ))}
            </div>
          </div>
          <div className="sl-camera-row">
            <span className="sl-camera-row-label">Program</span>
            <div className="sl-camera-row-buttons">
              {CAMERAS.map((cam) => (
                <button
                  key={cam}
                  className={`sl-cam-btn sl-cam-btn--pgm${programInput === cam ? ' active' : ''}`}
                  onClick={() => onSetProgram(cam)}
                  type="button"
                >
                  Cam {cam}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          className={`sl-output4-tile${output4IsProgram ? ' sl-output4-tile--program' : ''}`}
          onClick={onOutput4Toggle}
          type="button"
        >
          {output4IsProgram ? 'Switch to\nMultiview' : 'Switch to\nProgram'}
        </button>
      </div>

      <div className={`sl-atem-status-line${isRecording ? ' sl-atem-status-line--recording' : ''}`}>
        {connected
          ? `${travelMode.active ? '✈ ' : ''}${switcherIp}  ·  ${recordingFilename || '—'}`
          : (atemState?.bridgeAvailable ? 'Bridge ready · Not connected' : 'Bridge unavailable')}
      </div>
    </div>
  );
}
