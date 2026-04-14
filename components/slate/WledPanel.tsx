'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { WledStatus } from '@/lib/services/wled-service';

// ── CCT helpers ───────────────────────────────────────────────────────────────
// WLED cct: 0 = coldest, 255 → pct 100 = warmest.
// UI: 2700 K (warm/left) → 6500 K (cool/right).

const CCT_WARM_K = 2700;
const CCT_COOL_K = 6500;

function cctPctToK(pct: number): number {
  return Math.round(CCT_COOL_K - (pct / 100) * (CCT_COOL_K - CCT_WARM_K));
}

function kToCctPct(k: number): number {
  return Math.round((CCT_COOL_K - k) / (CCT_COOL_K - CCT_WARM_K) * 100);
}

// ── WledPanel ─────────────────────────────────────────────────────────────────

export function WledPanel() {
  const [status,       setStatus]       = useState<WledStatus | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ipDraft,      setIpDraft]      = useState('');

  const [brightness, setBrightness] = useState(50);
  const [cctK,       setCctK]       = useState(5600);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/studio/wled');
      const data = await res.json() as { status?: WledStatus };
      if (data.status) {
        setStatus(data.status);
        if (data.status.brightness !== undefined) setBrightness(data.status.brightness);
        if (data.status.cct        !== undefined) setCctK(cctPctToK(data.status.cct));
      }
    } catch { /* keep stale state */ }
  }, []);

  useEffect(() => {
    void fetchStatus();
    pollRef.current = setInterval(() => void fetchStatus(), 3_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    fetch('/api/studio/wled/config')
      .then((r) => r.json())
      .then((d: { config?: { ip: string } }) => { if (d.config?.ip) setIpDraft(d.config.ip); })
      .catch(() => {});
  }, []);

  async function sendCommand(method: string, params: Record<string, unknown> = {}) {
    setError(null);
    setLoading(true);
    try {
      const res  = await fetch('/api/studio/wled', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ method, params }),
      });
      const data = await res.json() as { ok?: boolean; status?: WledStatus; error?: string };
      if (!res.ok) { setError(data.error ?? 'Command failed'); return; }
      if (data.status) setStatus(data.status);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveIp() {
    await fetch('/api/studio/wled/config', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ip: ipDraft.trim() }),
    });
    setSettingsOpen(false);
    setTimeout(() => void fetchStatus(), 800);
  }

  const reachable = status?.reachable ?? false;

  return (
    <div className="lp-lighting-section">
      {/* Section header — dot + label + gear */}
      <div className="lp-lighting-section-header">
        <div className="lp-lighting-section-header-left">
          <span className={`lp-lighting-dot${reachable ? ' lp-lighting-dot--on' : ''}`} />
          Bookshelf
        </div>
        <button
          type="button"
          className={`lp-lighting-btn lp-lighting-btn--icon${settingsOpen ? ' lp-lighting-btn--active' : ''}`}
          onClick={() => setSettingsOpen((v) => !v)}
          title="WLED settings"
          aria-label="WLED settings"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 011.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 01-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 01-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 01-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 01.7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z"/>
            <circle cx="12" cy="12" r="3.4"/>
          </svg>
        </button>
      </div>

      {/* Settings drawer */}
      {settingsOpen && (
        <div className="lp-lighting-settings">
          <label className="lp-lighting-label">WLED device IP</label>
          <div className="lp-lighting-settings-row">
            <input
              className="lp-lighting-input"
              type="text"
              value={ipDraft}
              onChange={(e) => setIpDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveIp(); }}
              placeholder="192.168.1.50"
            />
            <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={() => void handleSaveIp()}>
              Save
            </button>
          </div>
          <p className="lp-lighting-hint">Local IP address of your WLED device.</p>
        </div>
      )}

      {error && <p className="lp-lighting-error">{error}</p>}

      {reachable && (
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
              >On</button>
              <button
                type="button"
                className={`lp-lighting-power-btn${status?.power === false ? ' lp-lighting-power-btn--off' : ''}`}
                onClick={() => void sendCommand('setPower', { on: false })}
                disabled={loading}
              >Off</button>
            </div>
          </div>

          {/* Brightness */}
          <div className="lp-lighting-row">
            <span className="lp-lighting-label">Brightness</span>
            <div className="lp-lighting-slider-group">
              <input
                type="range"
                className="lp-lighting-slider"
                min={0} max={100}
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                onMouseUp={() => void sendCommand('setBrightness', { pct: brightness })}
                onTouchEnd={() => void sendCommand('setBrightness', { pct: brightness })}
              />
              <span className="lp-lighting-slider-value">{brightness}%</span>
            </div>
          </div>

          {/* CCT in Kelvin */}
          <div className="lp-lighting-row">
            <span className="lp-lighting-label">Temperature</span>
            <div className="lp-lighting-slider-group">
              <input
                type="range"
                className="lp-lighting-slider lp-lighting-slider--cct"
                min={CCT_WARM_K}
                max={CCT_COOL_K}
                step={100}
                value={cctK}
                onChange={(e) => setCctK(Number(e.target.value))}
                onMouseUp={() => void sendCommand('setCct', { pct: kToCctPct(cctK) })}
                onTouchEnd={() => void sendCommand('setCct', { pct: kToCctPct(cctK) })}
              />
              <span className="lp-lighting-slider-value">{cctK}K</span>
            </div>
          </div>

        </div>
      )}

      {!reachable && !settingsOpen && (
        <div className="lp-lighting-placeholder">
          <p className="lp-lighting-hint">
            {ipDraft
              ? `Cannot reach WLED at ${ipDraft}. Check device is on and on the network.`
              : 'Enter the WLED device IP in settings to get started.'}
          </p>
        </div>
      )}
    </div>
  );
}
