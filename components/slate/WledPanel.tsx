'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { WledStatus } from '@/lib/services/wled-service';
import { FillSlider, cctFillColor, PowerIcon } from '@/components/slate/lighting-controls';
import type { PresetWledState } from '@/lib/store/lighting-presets-store';

const CCT_MIN_K = 2700;
const CCT_MAX_K = 6000;

function cctPctToK(pct: number): number {
  return Math.round(CCT_MIN_K + (pct / 100) * (CCT_MAX_K - CCT_MIN_K));
}

function kToCctPct(k: number): number {
  return Math.round((k - CCT_MIN_K) / (CCT_MAX_K - CCT_MIN_K) * 100);
}

interface WledPanelProps {
  snapshotRef?: React.MutableRefObject<(() => PresetWledState) | null>;
}

export function WledPanel({ snapshotRef }: WledPanelProps = {}) {
  const [status,  setStatus]  = useState<WledStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [ipDraft, setIpDraft] = useState('');

  const [brightness, setBrightness] = useState(50);
  const [cctK,       setCctK]       = useState(4350);

  // Register snapshot getter so LightingPanel can capture WLED state for presets
  useEffect(() => {
    if (!snapshotRef) return;
    snapshotRef.current = () => ({
      power:      status?.power ?? false,
      brightness,
      cctK,
    });
    return () => { if (snapshotRef) snapshotRef.current = null; };
  }); // intentionally no dep array — always reflects latest values

  const lastTouchedAt = useRef<number>(0);
  const touch = () => { lastTouchedAt.current = Date.now(); };
  const recentlyTouched = () => Date.now() - lastTouchedAt.current < 2000;

  const fetchStatus = useCallback(async (fromServer = false) => {
    try {
      const res  = await fetch('/api/studio/wled');
      const data = await res.json() as { status?: WledStatus };
      if (data.status) {
        setStatus(data.status);
        // Only sync slider state from server if user hasn't recently interacted
        if (!fromServer || !recentlyTouched()) {
          if (data.status.brightness !== undefined) setBrightness(data.status.brightness);
          if (data.status.cct        !== undefined) setCctK(cctPctToK(data.status.cct));
        }
      }
    } catch { /* keep stale state */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchStatus();
    // Poll infrequently — WLED has no push mechanism, but we don't need tight sync
    const timer = setInterval(() => void fetchStatus(true), 15_000);
    return () => clearInterval(timer);
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
      // Refresh slider state 1.5s after a command (after WLED applies it)
      setTimeout(() => void fetchStatus(), 1500);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  const reachable = status?.reachable ?? false;
  const isPowered = status?.power === true;

  return (
    <div className="lp-wled-panel">

      {error && <p className="lp-lighting-error">{error}</p>}

      {!reachable && (
        <p className="lp-lighting-hint">
          {ipDraft
            ? `Cannot reach WLED at ${ipDraft}.`
            : 'Enter WLED device IP in settings (gear icon above).'}
        </p>
      )}

      {reachable && (
        <div className={`lp-fixture-row${!isPowered ? ' lp-fixture-row--off' : ''}`}>

          {/* Header */}
          <div className="lp-fixture-row-header">
            <span className={`lp-lighting-dot${isPowered ? ' lp-lighting-dot--on' : ''}`} />
            <span className="lp-fixture-name-btn">Bookshelf LEDs</span>
          </div>

          {/* Controls — power + sliders */}
          <div className="lp-fixture-row-controls">
            <button
              type="button"
              className={`lp-fixture-power-btn${isPowered ? ' lp-fixture-power-btn--on' : ''}`}
              onClick={() => { touch(); void sendCommand('setPower', { on: !isPowered }); }}
              disabled={loading}
              aria-label={isPowered ? 'Turn off' : 'Turn on'}
            >
              <PowerIcon />
              <span>{isPowered ? 'ON' : 'OFF'}</span>
            </button>

            <div className="lp-fixture-row-sliders">
              <FillSlider
                value={brightness} min={0} max={100} label={`${brightness}%`}
                fillColor="rgba(255,255,255,0.88)"
                onChange={(v) => { touch(); setBrightness(v); }}
                onCommit={(v) => { if (isPowered) void sendCommand('setBrightness', { pct: v }); }}
              />
              <FillSlider
                value={cctK} min={CCT_MIN_K} max={CCT_MAX_K} label={`${cctK}K`}
                fillColor={cctFillColor(cctK)}
                step={100}
                onChange={(v) => { touch(); setCctK(v); }}
                onCommit={(v) => { if (isPowered) void sendCommand('setCct', { pct: kToCctPct(v) }); }}
              />
            </div>

            {/* Reserved space — keeps layout consistent with Amaran fixtures */}
            <div className="lp-fixture-row-wheel" />
          </div>

        </div>
      )}
    </div>
  );
}
