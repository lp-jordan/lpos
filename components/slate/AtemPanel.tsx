'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { AtemState } from '@/lib/services/atem-utils';
import type { TravelModeState } from '@/hooks/useSlate';

const TRAVEL_ATEM_IP = '10.10.10.241';
const HOME_ATEM_IP = '172.20.10.241';
const TRAVEL_BRIDGE_URL = 'http://100.110.17.100:4011';

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
  onCut: () => void;
  onAuto: () => void;
  onStartRecording: (filename?: string) => void;
  onStopRecording: () => void;
  onOutput4Toggle: () => void;
  output4Mode: 'multiview' | 'program';
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
}: Readonly<Props>) {
  const [ipInput, setIpInput] = useState(atemState?.switcherIp ?? '');
  const [filenameInput, setFilenameInput] = useState(atemState?.recording.filename ?? '');
  const [showChecklist, setShowChecklist] = useState(false);

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

      {/* ── Header ── */}
      <div className="at-head">
        <span className={`at-dot${connected ? ' at-dot--on' : ''}`} />
        <span className="at-title">ATEM</span>
        <button className="at-gear" type="button" onClick={onSettingsToggle} aria-label="ATEM settings">
          <GearIcon />
        </button>
      </div>
      <div className="at-subline">
        <span>{connectionText}</span>
        {isRecording && <span className="at-rec"><span className="at-rec-dot" />REC</span>}
      </div>

      {/* ── Monitors: what's live / what's cued ── */}
      <div className="at-mons">
        <div className="at-mon at-mon--pgm">
          <span className="at-mon-tag">● PROGRAM</span>
          <span className="at-mon-cam">{programInput ? `Cam ${programInput}` : '—'}</span>
        </div>
        <div className="at-mon at-mon--pvw">
          <span className="at-mon-tag">● PREVIEW</span>
          <span className="at-mon-cam">{previewInput ? `Cam ${previewInput}` : '—'}</span>
        </div>
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
            <div className="at-grabber" />
            <div className="at-sheet-head">
              <h3>ATEM settings</h3>
              <button className="at-sheet-close" type="button" onClick={onSettingsToggle} aria-label="Close"><CloseIcon /></button>
            </div>

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

            {atemState?.lastError && <p className="at-error">{atemState.lastError}</p>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
