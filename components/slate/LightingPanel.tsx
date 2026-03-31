'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AmaranStatus, AmaranColorMode } from '@/lib/services/amaran-service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function kelvinToLabel(k: number): string {
  if (k <= 2500) return 'Candlelight';
  if (k <= 3200) return 'Tungsten';
  if (k <= 4000) return 'Warm White';
  if (k <= 5000) return 'Neutral';
  if (k <= 5600) return 'Daylight';
  if (k <= 6500) return 'Overcast';
  return 'Cool Blue';
}

// ── LightingPanel ─────────────────────────────────────────────────────────────

export function LightingPanel() {
  const [status,       setStatus]       = useState<AmaranStatus | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [portDraft,    setPortDraft]    = useState('33782');
  const [activeMode,   setActiveMode]   = useState<AmaranColorMode>('cct');

  // Local slider states (optimistic — updated before API round-trip)
  const [brightness,   setBrightness]   = useState(50);
  const [cct,          setCct]          = useState(5600);
  const [hue,          setHue]          = useState(0);
  const [saturation,   setSaturation]   = useState(100);
  const [hsiIntensity, setHsiIntensity] = useState(50);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch status ────────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/studio/lighting');
      const data = await res.json() as { status?: AmaranStatus; error?: string };
      if (data.status) {
        setStatus(data.status);
        // Sync local slider state from server
        if (data.status.brightness !== null) { setBrightness(data.status.brightness); setHsiIntensity(data.status.brightness); }
        if (data.status.cct        !== null) setCct(data.status.cct);
        if (data.status.hue        !== null) setHue(data.status.hue);
        if (data.status.saturation !== null) setSaturation(data.status.saturation);
        if (data.status.mode)                setActiveMode(data.status.mode);
      }
    } catch { /* network error — keep stale state */ }
  }, []);

  // Poll every 3s when connected
  useEffect(() => {
    void fetchStatus();
    pollRef.current = setInterval(() => void fetchStatus(), 3_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  // ── Commands ────────────────────────────────────────────────────────────────

  async function sendCommand(method: string, params: Record<string, unknown> = {}) {
    setError(null);
    setLoading(true);
    try {
      const res  = await fetch('/api/studio/lighting', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ method, params }),
      });
      const data = await res.json() as { ok?: boolean; status?: AmaranStatus; error?: string };
      if (!res.ok) { setError(data.error ?? 'Command failed'); return; }
      if (data.status) setStatus(data.status);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    setError(null);
    try {
      const port = parseInt(portDraft, 10) || 33782;
      await fetch('/api/studio/lighting/connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ port }),
      });
      // Persist port to config
      await fetch('/api/studio/lighting/config', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ port }),
      });
      await fetchStatus();
    } catch { setError('Could not connect'); }
  }

  async function handleDisconnect() {
    await fetch('/api/studio/lighting/connect', { method: 'DELETE' });
    await fetchStatus();
  }

  async function handleSavePort() {
    const port = parseInt(portDraft, 10) || 33782;
    await fetch('/api/studio/lighting/config', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ port }),
    });
    setSettingsOpen(false);
  }

  // Load config on mount
  useEffect(() => {
    fetch('/api/studio/lighting/config')
      .then((r) => r.json())
      .then((d: { config?: { port: number } }) => {
        if (d.config?.port) setPortDraft(String(d.config.port));
      })
      .catch(() => {});
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const connected = status?.connected ?? false;

  return (
    <div className="lp-lighting">

      {/* ── Connection bar ── */}
      <div className="lp-lighting-topbar">
        <div className="lp-lighting-status">
          <span className={`lp-lighting-dot${connected ? ' lp-lighting-dot--on' : ''}`} />
          <span className="lp-lighting-status-label">
            {connected
              ? (status?.fixtures[0]?.name ?? 'Amaran Desktop connected')
              : 'Not connected'}
          </span>
        </div>
        <div className="lp-lighting-topbar-actions">
          {connected ? (
            <button type="button" className="lp-lighting-btn lp-lighting-btn--muted" onClick={() => void handleDisconnect()}>
              Disconnect
            </button>
          ) : (
            <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={() => void handleConnect()}>
              Connect
            </button>
          )}
          <button
            type="button"
            className={`lp-lighting-btn lp-lighting-btn--icon${settingsOpen ? ' lp-lighting-btn--active' : ''}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Settings"
            aria-label="Lighting settings"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 011.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 01-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 01-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 01-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 01.7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z"/>
              <circle cx="12" cy="12" r="3.4"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Settings drawer ── */}
      {settingsOpen && (
        <div className="lp-lighting-settings">
          <label className="lp-lighting-label">Amaran Desktop port</label>
          <div className="lp-lighting-settings-row">
            <input
              className="lp-lighting-input"
              type="number"
              min={1024}
              max={65535}
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSavePort(); }}
              placeholder="33782"
            />
            <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={() => void handleSavePort()}>
              Save
            </button>
          </div>
          <p className="lp-lighting-hint">Default: 33782. Amaran Desktop must be running.</p>
        </div>
      )}

      {error && <p className="lp-lighting-error">{error}</p>}

      {/* ── Controls (only when connected) ── */}
      {connected && (
        <div className="lp-lighting-controls">

          {/* Power */}
          <div className="lp-lighting-row">
            <span className="lp-lighting-label">Power</span>
            <div className="lp-lighting-power">
              <button
                type="button"
                className={`lp-lighting-power-btn${status?.power === true ? ' lp-lighting-power-btn--on' : ''}`}
                onClick={() => void sendCommand('setPower', { on: true })}
                disabled={loading}
              >
                On
              </button>
              <button
                type="button"
                className={`lp-lighting-power-btn${status?.power === false ? ' lp-lighting-power-btn--off' : ''}`}
                onClick={() => void sendCommand('setPower', { on: false })}
                disabled={loading}
              >
                Off
              </button>
            </div>
          </div>

          {/* Brightness */}
          <div className="lp-lighting-row">
            <span className="lp-lighting-label">Brightness</span>
            <div className="lp-lighting-slider-group">
              <input
                type="range"
                className="lp-lighting-slider"
                min={0}
                max={100}
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                onMouseUp={() => void sendCommand('setBrightness', { pct: brightness })}
                onTouchEnd={() => void sendCommand('setBrightness', { pct: brightness })}
              />
              <span className="lp-lighting-slider-value">{brightness}%</span>
            </div>
          </div>

          {/* Color mode tabs */}
          <div className="lp-lighting-row">
            <span className="lp-lighting-label">Mode</span>
            <div className="lp-lighting-mode-tabs">
              {(['cct', 'hsi'] as AmaranColorMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`lp-lighting-mode-tab${activeMode === m ? ' lp-lighting-mode-tab--active' : ''}`}
                  onClick={() => setActiveMode(m)}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* CCT mode */}
          {activeMode === 'cct' && (
            <div className="lp-lighting-mode-section">
              <div className="lp-lighting-row">
                <span className="lp-lighting-label">Temperature</span>
                <div className="lp-lighting-slider-group">
                  <input
                    type="range"
                    className="lp-lighting-slider lp-lighting-slider--cct"
                    min={2500}
                    max={7500}
                    step={100}
                    value={cct}
                    onChange={(e) => setCct(Number(e.target.value))}
                    onMouseUp={() => void sendCommand('setCCT', { kelvin: cct })}
                    onTouchEnd={() => void sendCommand('setCCT', { kelvin: cct })}
                  />
                  <span className="lp-lighting-slider-value">{cct}K</span>
                </div>
              </div>
              <p className="lp-lighting-hint lp-lighting-cct-label">{kelvinToLabel(cct)}</p>
            </div>
          )}

          {/* HSI mode */}
          {activeMode === 'hsi' && (
            <div className="lp-lighting-mode-section">
              {([
                { label: 'Hue',        value: hue,          setter: setHue,          min: 0,   max: 360, step: 1,  unit: '°',  key: 'hue'        },
                { label: 'Saturation', value: saturation,   setter: setSaturation,   min: 0,   max: 100, step: 1,  unit: '%',  key: 'saturation' },
                { label: 'Intensity',  value: hsiIntensity, setter: setHsiIntensity, min: 0,   max: 100, step: 1,  unit: '%',  key: 'intensity'  },
              ] as Array<{ label: string; value: number; setter: (v: number) => void; min: number; max: number; step: number; unit: string; key: string }>).map(({ label, value, setter, min, max, step, unit, key }) => (
                <div key={key} className="lp-lighting-row">
                  <span className="lp-lighting-label">{label}</span>
                  <div className="lp-lighting-slider-group">
                    <input
                      type="range"
                      className="lp-lighting-slider"
                      min={min}
                      max={max}
                      step={step}
                      value={value}
                      onChange={(e) => setter(Number(e.target.value))}
                      onMouseUp={() => void sendCommand('setHSI', { hue, saturation, brightness: hsiIntensity })}
                      onTouchEnd={() => void sendCommand('setHSI', { hue, saturation, brightness: hsiIntensity })}
                    />
                    <span className="lp-lighting-slider-value">{value}{unit}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>
      )}

      {/* ── Disconnected placeholder ── */}
      {!connected && !settingsOpen && (
        <div className="lp-lighting-placeholder">
          <p className="lp-lighting-hint">Open Amaran Desktop, ensure your lights are paired, then click Connect.</p>
        </div>
      )}

    </div>
  );
}
