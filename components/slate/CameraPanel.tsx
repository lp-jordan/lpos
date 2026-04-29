'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientAudioMonitorState } from '@/hooks/useSlate';
import { SonyCameraPanel } from './SonyCameraPanel';

type AtemDevice = { index: string; label: string };
type CameraSource = 'atem' | 'sony';

interface Props {
  audioMonitor: ClientAudioMonitorState;
  onSetAudioMuted: (muted: boolean) => void;
}

export function CameraPanel({ audioMonitor, onSetAudioMuted }: Props) {
  const [source, setSource] = useState<CameraSource>('atem');

  // ── ATEM feed state ────────────────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false);
  const [devices, setDevices] = useState<AtemDevice[]>([]);
  const [deviceIndex, setDeviceIndex] = useState('0');
  const [savedIndex, setSavedIndex] = useState('0');
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [feedKey, setFeedKey] = useState(0);

  // ── Fullscreen ─────────────────────────────────────────────────────────────
  // iOS Safari doesn't support the Fullscreen API on arbitrary elements.
  // We detect support and fall back to a CSS fixed overlay so iPad works too.
  const panelRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const nativeFs = typeof document !== 'undefined' && !!document.fullscreenEnabled;

  useEffect(() => {
    if (!nativeFs) return;
    function onFsChange() { setIsFullscreen(!!document.fullscreenElement); }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [nativeFs]);

  function toggleFullscreen() {
    if (nativeFs) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        panelRef.current?.requestFullscreen();
      }
    } else {
      setIsFullscreen((v) => !v);
    }
  }

  // ── Device config ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/studio/camera/config')
      .then((r) => r.ok ? r.json() : null)
      .then((data: { camera?: { atemVideoDeviceIndex?: string } } | null) => {
        const idx = (data?.camera?.atemVideoDeviceIndex ?? '').trim() || '0';
        setDeviceIndex(idx);
        setSavedIndex(idx);
      })
      .catch(() => {});
  }, []);

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const res = await fetch('/api/studio/camera/atem-devices');
      const data = await res.json() as { devices?: AtemDevice[] };
      setDevices(data.devices ?? []);
    } catch {
      setDevices([]);
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  async function handleApply() {
    await fetch('/api/studio/camera/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera: { atemVideoDeviceIndex: deviceIndex } }),
    });
    setSavedIndex(deviceIndex);
    setFeedError(false);
    setFeedKey((k) => k + 1);
    setShowSettings(false);
  }

  return (
    <div className={`cam-panel${isFullscreen && !nativeFs ? ' cam-panel--overlay-fs' : ''}`} ref={panelRef}>
      {/* ── Header ── */}
      <div className="sl-atem-header">
        <span className="sl-atem-title">Camera Monitoring</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>

          {/* Audio monitor button (ATEM mode only) */}
          {source === 'atem' && (
            <button
              type="button"
              className={`cam-monitor-btn${!audioMonitor.locallyMuted && audioMonitor.phase !== 'blocked' ? ' cam-monitor-btn--live' : ''}`}
              onClick={() => onSetAudioMuted(!audioMonitor.locallyMuted)}
              disabled={audioMonitor.phase === 'no_source'}
              title={audioMonitor.locallyMuted ? 'Unmute audio monitor' : 'Mute audio monitor'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {audioMonitor.locallyMuted ? (
                  <>
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                  </>
                ) : (
                  <>
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </>
                )}
              </svg>
              Monitor
            </button>
          )}

          {/* Fullscreen toggle */}
          <button
            type="button"
            className="sl-gear-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>

          {/* Source toggle pill */}
          <div className="cam-source-toggle">
            <button
              type="button"
              className={`cam-source-toggle-btn${source === 'atem' ? ' cam-source-toggle-btn--active' : ''}`}
              onClick={() => setSource('atem')}
            >
              ATEM
            </button>
            <button
              type="button"
              className={`cam-source-toggle-btn${source === 'sony' ? ' cam-source-toggle-btn--active' : ''}`}
              onClick={() => setSource('sony')}
            >
              Sony
            </button>
          </div>

          {/* Gear (ATEM mode only) */}
          {source === 'atem' && (
            <button
              type="button"
              className={`sl-gear-btn${showSettings ? ' sl-gear-btn--open' : ''}`}
              title="Video source settings"
              onClick={() => {
                const next = !showSettings;
                setShowSettings(next);
                if (next) void loadDevices();
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── ATEM content ── */}
      {source === 'atem' && (
        <>
          {showSettings && (
            <div className="cam-settings-row">
              <div className="cam-setting" style={{ flex: 1 }}>
                <span className="cam-setting-label">Source</span>
                <select
                  className="cam-select"
                  value={deviceIndex}
                  onChange={(e) => setDeviceIndex(e.target.value)}
                  disabled={loadingDevices}
                >
                  {loadingDevices
                    ? <option value="">Loading…</option>
                    : devices.length === 0
                      ? <option value="0">Device 0 (default)</option>
                      : devices.map((d) => (
                          <option key={d.index} value={d.index}>[{d.index}] {d.label}</option>
                        ))
                  }
                </select>
              </div>
              <button type="button" className="cam-btn cam-btn--connect" onClick={() => void handleApply()}>
                Apply
              </button>
            </div>
          )}

          <div className="cam-monitor-wrap">
            {!feedError ? (
              <img
                key={feedKey}
                className="cam-monitor"
                src={`/api/studio/camera/atem-liveview?t=${feedKey}`}
                alt="ATEM liveview"
                onError={() => setFeedError(true)}
              />
            ) : (
              <div className="cam-monitor-placeholder">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <span>Feed unavailable — check the Cam Link is connected and device index is correct</span>
                <button type="button" className="cam-btn cam-btn--sm"
                  onClick={() => { setFeedError(false); setFeedKey((k) => k + 1); }}>
                  Retry
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Sony content ── */}
      {source === 'sony' && <SonyCameraPanel />}
    </div>
  );
}
