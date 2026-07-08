'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { WledStatus } from '@/lib/services/wled-service';
import { FillSlider, cctFillColor } from '@/components/slate/lighting-controls';
import type { PresetWledState } from '@/lib/store/lighting-presets-store';

const CCT_MIN_K = 2700;
const CCT_MAX_K = 6000;

function cctPctToK(pct: number): number {
  return Math.round(CCT_MIN_K + (pct / 100) * (CCT_MAX_K - CCT_MIN_K));
}

function kToCctPct(k: number): number {
  return Math.round((k - CCT_MIN_K) / (CCT_MAX_K - CCT_MIN_K) * 100);
}

// Local icon copies — kept here to avoid a circular import with LightingPanel.
function BulbIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 21h4"/>
      <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3Z"/>
    </svg>
  );
}
function PowerGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
      <path d="M12 3v9"/>
      <path d="M6.5 7a8 8 0 1 0 11 0"/>
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

interface WledTileProps {
  snapshotRef?: React.MutableRefObject<(() => PresetWledState) | null>;
}

/** The bookshelf WLED strip, rendered as a tile that opens its own control
 *  sheet — mirrors the Amaran FixtureTile so it sits cohesively in the
 *  Bookshelves room grid. All WLED logic (polling, snapshot, commands) is
 *  unchanged from the previous WledPanel. */
export function WledTile({ snapshotRef }: WledTileProps = {}) {
  const [status,  setStatus]  = useState<WledStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [ipDraft, setIpDraft] = useState('');
  const [open,    setOpen]    = useState(false);

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
        if (!fromServer || !recentlyTouched()) {
          if (data.status.brightness !== undefined) setBrightness(data.status.brightness);
          if (data.status.cct        !== undefined) setCctK(cctPctToK(data.status.cct));
        }
      }
    } catch { /* keep stale state */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchStatus();
    const timer = setInterval(() => void fetchStatus(true), 15_000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  useEffect(() => {
    fetch('/api/studio/wled/config')
      .then((r) => r.json())
      .then((d: { config?: { ip: string } }) => { if (d.config?.ip) setIpDraft(d.config.ip); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

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
      setTimeout(() => void fetchStatus(), 1500);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  const reachable = status?.reachable ?? false;
  const isPowered = status?.power === true;
  const glow = cctFillColor(cctK);

  // Offline — a static informational tile so the grid stays whole.
  if (!reachable) {
    return (
      <div className="lp-tile lp-tile--hint" aria-label="Bookshelf LEDs offline">
        <span className="lp-tile-c">
          <span className="lp-tile-top">
            <span className="lp-tile-ico"><BulbIcon /></span>
          </span>
          <span className="lp-tile-body">
            <span className="lp-tile-name">Bookshelf LEDs</span>
            <span className="lp-tile-state">{ipDraft ? 'Unreachable' : 'No IP set'}</span>
          </span>
        </span>
      </div>
    );
  }

  const stateText = isPowered ? `${Math.round(brightness)}%  ·  ${cctK}K` : 'Off';
  const fillHeight = isPowered ? `${Math.max(12, Math.round(brightness))}%` : '0%';

  return (
    <>
      <div
        className={`lp-tile${isPowered ? ' lp-tile--on' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`Bookshelf LEDs — ${stateText}. Open controls`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        style={{
          borderColor: isPowered ? glow : undefined,
          boxShadow: isPowered ? `0 8px 30px -12px ${glow}` : undefined,
        }}
      >
        <span className="lp-tile-fill" style={{ height: fillHeight, background: glow, opacity: isPowered ? 0.55 : 0.12 }} />
        <span className="lp-tile-veil" />
        <span className="lp-tile-c">
          <span className="lp-tile-top">
            <span className="lp-tile-ico"><BulbIcon /></span>
            <button
              type="button"
              className="lp-tile-pw"
              onClick={(e) => { e.stopPropagation(); touch(); void sendCommand('setPower', { on: !isPowered }); }}
              disabled={loading}
              aria-label={isPowered ? 'Turn off' : 'Turn on'}
            >
              <PowerGlyph />
            </button>
          </span>
          <span className="lp-tile-body">
            <span className="lp-tile-name">Bookshelf LEDs</span>
            <span className="lp-tile-state">{stateText}</span>
          </span>
        </span>
      </div>

      {open && createPortal(
        <div className="lp-sheet-backdrop lp-sheet-backdrop--show" onClick={() => setOpen(false)}>
          <div className="lp-sheet lp-sheet--show" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bookshelf LEDs controls">
            <div className="lp-sheet-grabber" />

            <div className="lp-sheet-head">
              <span className="lp-sheet-glow" style={{ background: isPowered ? glow : 'var(--surface-raised)', color: glow }} />
              <div className="lp-sheet-titles">
                <span className="lp-sheet-title lp-sheet-title--static">Bookshelf LEDs</span>
                <span className="lp-sheet-meta">WLED strip</span>
              </div>
              <button
                type="button"
                className={`lp-tile-pw lp-sheet-power${isPowered ? ' lp-tile--on' : ''}`}
                onClick={() => { touch(); void sendCommand('setPower', { on: !isPowered }); }}
                disabled={loading}
                aria-label={isPowered ? 'Turn off' : 'Turn on'}
              >
                <PowerGlyph />
              </button>
              <button type="button" className="lp-sheet-close" onClick={() => setOpen(false)} aria-label="Close"><CloseIcon /></button>
            </div>

            {error && <p className="lp-lighting-error">{error}</p>}

            <div className="lp-sheet-label"><span>Brightness</span><span>{Math.round(brightness)}%</span></div>
            <FillSlider
              value={brightness} min={0} max={100} label=""
              fillColor="rgba(255,255,255,0.9)"
              onChange={(v) => { touch(); setBrightness(v); }}
              onCommit={(v) => { if (isPowered) void sendCommand('setBrightness', { pct: v }); }}
            />

            <div className="lp-sheet-label"><span>Colour temperature</span><span>{cctK}K</span></div>
            <FillSlider
              value={cctK} min={CCT_MIN_K} max={CCT_MAX_K} step={100} label=""
              fillColor={cctFillColor(cctK)}
              onChange={(v) => { touch(); setCctK(v); }}
              onCommit={(v) => { if (isPowered) void sendCommand('setCct', { pct: kToCctPct(v) }); }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
