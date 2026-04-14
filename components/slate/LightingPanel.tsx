'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AmaranStatus, AmaranColorMode, AmaranFixtureState, AmaranFixture } from '@/lib/services/amaran-service';
import { WledPanel } from '@/components/slate/WledPanel';

// ── Color helpers ─────────────────────────────────────────────────────────────

function fixtureCardBg(state: AmaranFixtureState | undefined): string {
  if (!state || state.power === false) return '#18181b';
  if (state.mode === 'hsi' && state.hue != null) {
    return `hsl(${state.hue}deg,${state.saturation ?? 100}%,55%)`;
  }
  const k = state.cct ?? 5600;
  const t = Math.max(0, Math.min(1, (k - 2500) / 5000));
  const r = Math.round(255 - t * 60);
  const g = Math.round(158 + t * 82);
  const b = Math.round(38  + t * 217);
  return `rgb(${r},${g},${b})`;
}

function cardTextColor(state: AmaranFixtureState | undefined): string {
  return (!state || state.power === false) ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.60)';
}

// ── Gear icon (shared) ────────────────────────────────────────────────────────

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 011.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 01-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 01-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 01-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 01.7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z"/>
      <circle cx="12" cy="12" r="3.4"/>
    </svg>
  );
}

// ── AmaranFixtureCard ─────────────────────────────────────────────────────────

interface CardProps {
  fixture:  AmaranFixture;
  state:    AmaranFixtureState | undefined;
  selected: boolean;
  onSelect: () => void;
}

function AmaranFixtureCard({ fixture, state, selected, onSelect }: CardProps) {
  const bg       = fixtureCardBg(state);
  const txtColor = cardTextColor(state);
  const bri      = state?.brightness ?? 0;
  const isOff    = state?.power === false;

  return (
    <button
      type="button"
      className={`lp-fixture-card${selected ? ' lp-fixture-card--selected' : ''}${isOff ? ' lp-fixture-card--off' : ''}`}
      style={{ background: bg, color: txtColor }}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="lp-fixture-card-pct">{isOff ? 'Off' : `${bri}%`}</span>
      <span className="lp-fixture-card-name">{fixture.name}</span>
    </button>
  );
}

// ── AmaranFixtureDetail ───────────────────────────────────────────────────────

interface DetailProps {
  fixture:   AmaranFixture;
  state:     AmaranFixtureState | undefined;
  loading:   boolean;
  onCommand: (method: string, nodeId: string, params?: Record<string, unknown>) => void;
}

function AmaranFixtureDetail({ fixture, state, loading, onCommand }: DetailProps) {
  const [activeMode,   setActiveMode]   = useState<AmaranColorMode>(state?.mode ?? 'cct');
  const [brightness,   setBrightness]   = useState(state?.brightness   ?? 50);
  const [cct,          setCct]          = useState(state?.cct           ?? 5600);
  const [hue,          setHue]          = useState(state?.hue           ?? 0);
  const [saturation,   setSaturation]   = useState(state?.saturation    ?? 100);
  const [hsiIntensity, setHsiIntensity] = useState(state?.brightness    ?? 50);

  useEffect(() => {
    if (state?.mode)               setActiveMode(state.mode);
    if (state?.brightness != null) { setBrightness(state.brightness); setHsiIntensity(state.brightness); }
    if (state?.cct        != null) setCct(state.cct);
    if (state?.hue        != null) setHue(state.hue);
    if (state?.saturation != null) setSaturation(state.saturation);
  }, [state]);

  const id    = fixture.nodeId;
  const power = state?.power;

  return (
    <div className="lp-fixture-detail">
      <div className="lp-fixture-detail-header">{fixture.name}</div>

      <div className="lp-lighting-row">
        <span className="lp-lighting-label">Power</span>
        <div className="lp-lighting-power">
          <button
            type="button"
            className={`lp-lighting-power-btn${power === true ? ' lp-lighting-power-btn--on' : ''}`}
            onClick={() => onCommand('setPower', id, { on: true })}
            disabled={loading}
          >On</button>
          <button
            type="button"
            className={`lp-lighting-power-btn${power === false ? ' lp-lighting-power-btn--off' : ''}`}
            onClick={() => onCommand('setPower', id, { on: false })}
            disabled={loading}
          >Off</button>
        </div>
      </div>

      <div className="lp-lighting-row">
        <span className="lp-lighting-label">Brightness</span>
        <div className="lp-lighting-slider-group">
          <input
            type="range" className="lp-lighting-slider"
            min={0} max={100} value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
            onMouseUp={() => onCommand('setBrightness', id, { pct: brightness })}
            onTouchEnd={() => onCommand('setBrightness', id, { pct: brightness })}
          />
          <span className="lp-lighting-slider-value">{brightness}%</span>
        </div>
      </div>

      <div className="lp-lighting-row">
        <span className="lp-lighting-label">Mode</span>
        <div className="lp-lighting-mode-tabs">
          {(['cct', 'hsi'] as AmaranColorMode[]).map((m) => (
            <button key={m} type="button"
              className={`lp-lighting-mode-tab${activeMode === m ? ' lp-lighting-mode-tab--active' : ''}`}
              onClick={() => setActiveMode(m)}
            >{m.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {activeMode === 'cct' && (
        <div className="lp-lighting-row">
          <span className="lp-lighting-label">Temperature</span>
          <div className="lp-lighting-slider-group">
            <input
              type="range" className="lp-lighting-slider lp-lighting-slider--cct"
              min={2500} max={7500} step={100} value={cct}
              onChange={(e) => setCct(Number(e.target.value))}
              onMouseUp={() => onCommand('setCCT', id, { kelvin: cct })}
              onTouchEnd={() => onCommand('setCCT', id, { kelvin: cct })}
            />
            <span className="lp-lighting-slider-value">{cct}K</span>
          </div>
        </div>
      )}

      {activeMode === 'hsi' && (
        <div className="lp-lighting-mode-section">
          {([
            { label: 'Hue',        value: hue,          setter: setHue,          min: 0, max: 360, unit: '°', key: 'hue' },
            { label: 'Saturation', value: saturation,   setter: setSaturation,   min: 0, max: 100, unit: '%', key: 'sat' },
            { label: 'Intensity',  value: hsiIntensity, setter: setHsiIntensity, min: 0, max: 100, unit: '%', key: 'int' },
          ] as Array<{ label: string; value: number; setter: (v: number) => void; min: number; max: number; unit: string; key: string }>).map(({ label, value, setter, min, max, unit, key }) => (
            <div key={key} className="lp-lighting-row">
              <span className="lp-lighting-label">{label}</span>
              <div className="lp-lighting-slider-group">
                <input
                  type="range" className="lp-lighting-slider"
                  min={min} max={max} value={value}
                  onChange={(e) => setter(Number(e.target.value))}
                  onMouseUp={() => onCommand('setHSI', id, { hue, saturation, brightness: hsiIntensity })}
                  onTouchEnd={() => onCommand('setHSI', id, { hue, saturation, brightness: hsiIntensity })}
                />
                <span className="lp-lighting-slider-value">{value}{unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── LightingPanel ─────────────────────────────────────────────────────────────

export function LightingPanel() {
  const [status,         setStatus]         = useState<AmaranStatus | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [settingsOpen,   setSettingsOpen]   = useState(false);
  const [portDraft,      setPortDraft]      = useState('33782');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/studio/lighting');
      const data = await res.json() as { status?: AmaranStatus };
      if (data.status) {
        setStatus(data.status);
        setSelectedNodeId((prev) => prev ?? data.status?.fixtures[0]?.nodeId ?? null);
      }
    } catch { /* keep stale state */ }
  }, []);

  useEffect(() => {
    void fetchStatus();
    pollRef.current = setInterval(() => void fetchStatus(), 3_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    fetch('/api/studio/lighting/config')
      .then((r) => r.json())
      .then((d: { config?: { port: number } }) => { if (d.config?.port) setPortDraft(String(d.config.port)); })
      .catch(() => {});
  }, []);

  async function sendCommand(method: string, nodeId: string, params: Record<string, unknown> = {}) {
    setError(null);
    setLoading(true);
    try {
      const res  = await fetch('/api/studio/lighting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, nodeId, params }),
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await fetch('/api/studio/lighting/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await fetchStatus();
    } catch { setError('Could not connect'); }
  }

  async function handleDisconnect() {
    await fetch('/api/studio/lighting/connect', { method: 'DELETE' });
    setSelectedNodeId(null);
    await fetchStatus();
  }

  async function handleSavePort() {
    const port = parseInt(portDraft, 10) || 33782;
    await fetch('/api/studio/lighting/config', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    setSettingsOpen(false);
  }

  const connected      = status?.connected ?? false;
  const fixtures       = status?.fixtures  ?? [];
  const selectedFixture = fixtures.find((f) => f.nodeId === selectedNodeId);

  return (
    <div className="lp-lighting-tab">

      {/* ═══ Bookshelf (WLED) — renders its own section header ═══ */}
      <WledPanel />

      {/* ═══ Amaran Lights ═══ */}
      <div className="lp-lighting-section">

        {/* Section header: dot + label + connect/disconnect + gear */}
        <div className="lp-lighting-section-header">
          <div className="lp-lighting-section-header-left">
            <span className={`lp-lighting-dot${connected ? ' lp-lighting-dot--on' : ''}`} />
            Amaran Lights
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
              title="Amaran Desktop port"
            >
              <GearIcon />
            </button>
          </div>
        </div>

        {settingsOpen && (
          <div className="lp-lighting-settings">
            <label className="lp-lighting-label">Amaran Desktop port</label>
            <div className="lp-lighting-settings-row">
              <input
                className="lp-lighting-input"
                type="number" min={1024} max={65535}
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

        {/* Fixture cards */}
        {connected && fixtures.length > 0 && (
          <>
            <div className="lp-fixture-cards">
              {fixtures.map((fixture) => (
                <AmaranFixtureCard
                  key={fixture.nodeId}
                  fixture={fixture}
                  state={status?.states[fixture.nodeId]}
                  selected={selectedNodeId === fixture.nodeId}
                  onSelect={() => setSelectedNodeId((prev) => prev === fixture.nodeId ? null : fixture.nodeId)}
                />
              ))}
            </div>

            {selectedFixture && (
              <AmaranFixtureDetail
                key={selectedFixture.nodeId}
                fixture={selectedFixture}
                state={status?.states[selectedFixture.nodeId]}
                loading={loading}
                onCommand={sendCommand}
              />
            )}
          </>
        )}

        {!connected && !settingsOpen && (
          <div className="lp-lighting-placeholder">
            <p className="lp-lighting-hint">Open Amaran Desktop, ensure your lights are paired, then click Connect.</p>
          </div>
        )}
      </div>

    </div>
  );
}
