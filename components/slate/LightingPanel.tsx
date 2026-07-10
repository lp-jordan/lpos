'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AmaranFixture, AmaranFixtureState, AmaranColorMode } from '@/lib/services/amaran-service';
import { useLighting } from '@/hooks/useLighting';
import { AMARAN_GROUPS, GROUP_LABELS, type AmaranFixtureGroup } from '@/lib/lighting-constants';
import { WledTile } from '@/components/slate/WledPanel';
import { FillSlider, cctFillColor } from '@/components/slate/lighting-controls';
import { useLightingPresets, snapshotAmaran, findIncompleteFixtures } from '@/hooks/useLightingPresets';
import type { PresetWledState } from '@/lib/store/lighting-presets-store';
import {
  PresetsModal, EditingBar, NameDialog, SaveWarningDialog,
} from '@/components/slate/LightingPresets';

// ── Icons ─────────────────────────────────────────────────────────────────────

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ animation: spinning ? 'spin 0.7s linear infinite' : undefined }}
    >
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 2.6h3.4l.6 2.5a7.9 7.9 0 011.8.7l2.2-1.3 2.4 2.4-1.3 2.2c.3.6.5 1.2.7 1.8l2.5.6v3.4l-2.5.6a7.9 7.9 0 01-.7 1.8l1.3 2.2-2.4 2.4-2.2-1.3c-.6.3-1.2.5-1.8.7l-.6 2.5h-3.4l-.6-2.5a7.9 7.9 0 01-1.8-.7l-2.2 1.3-2.4-2.4 1.3-2.2a7.9 7.9 0 01-.7-1.8l-2.5-.6v-3.4l2.5-.6a7.9 7.9 0 01.7-1.8L3.8 7l2.4-2.4 2.2 1.3c.6-.3 1.2-.5 1.8-.7z"/>
      <circle cx="12" cy="12" r="3.4"/>
    </svg>
  );
}

/** Filament bulb — the shared tile glyph. */
export function BulbIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 21h4"/>
      <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3Z"/>
    </svg>
  );
}

/** Power ⏻ glyph for the tile toggle dot. */
export function TilePowerGlyph() {
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

// ── Colour helpers ────────────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** The colour a fixture is currently emitting — drives the tile glow + sheet swatch. */
export function glowColor(mode: AmaranColorMode, cct: number, hue: number, sat: number, hasHSI: boolean): string {
  if (hasHSI && mode === 'hsi') {
    const [r, g, b] = hslToRgb(hue, sat, 58);
    return `rgb(${r},${g},${b})`;
  }
  return cctFillColor(cct);
}

// ── ColorWheel ────────────────────────────────────────────────────────────────

interface ColorWheelProps {
  hue: number; saturation: number; active: boolean;
  onChange: (hue: number, saturation: number) => void;
}

function ColorWheel({ hue, saturation, active, onChange }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const SIZE = 168; const R = SIZE / 2;

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const img = ctx.createImageData(SIZE, SIZE); const data = img.data;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = x - R, dy = y - R, dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > R) continue;
        const angle = Math.atan2(dy, dx);
        const h = ((angle * 180 / Math.PI) + 360) % 360, s = (dist / R) * 100;
        const [r, g, b] = hslToRgb(h, s, 50);
        const idx = (y * SIZE + x) * 4;
        data[idx] = r; data[idx+1] = g; data[idx+2] = b; data[idx+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const selAngle = hue * Math.PI / 180, selDist = (saturation / 100) * R;
    const sx = R + Math.cos(selAngle) * selDist, sy = R + Math.sin(selAngle) * selDist;
    ctx.beginPath(); ctx.arc(sx, sy, 9, 0, 2*Math.PI);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, 9, 0, 2*Math.PI);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
  }, [hue, saturation, active, R]);

  const getCoords = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (SIZE / rect.width);
    const cy = (e.clientY - rect.top)  * (SIZE / rect.height);
    const dx = cx - R, dy = cy - R;
    const dist = Math.min(Math.sqrt(dx*dx + dy*dy), R);
    onChange(
      Math.round(((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360),
      Math.round((dist / R) * 100),
    );
  }, [R, onChange]);

  return (
    <canvas ref={canvasRef} width={SIZE} height={SIZE} className="lp-sheet-wheel-canvas"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); getCoords(e); }}
      onPointerMove={(e) => { if (e.buttons > 0) getCoords(e); }}
    />
  );
}

// ── Capabilities ──────────────────────────────────────────────────────────────

function useCaps(fixture: AmaranFixture) {
  return {
    hasHSI: fixture.capabilities?.hasHSI ?? true,
    cctMin: fixture.capabilities?.cctMin ?? 2500,
    cctMax: fixture.capabilities?.cctMax ?? 7500,
  };
}

// ── FixtureTile (+ its detail sheet) ──────────────────────────────────────────

interface FixtureTileProps {
  fixture:      AmaranFixture;
  state:        AmaranFixtureState | undefined;
  label:        string;
  group:        AmaranFixtureGroup | undefined;
  loading:      boolean;
  isAdmin:      boolean;
  open:         boolean;
  onOpen:       (nodeId: string) => void;
  onClose:      () => void;
  onCommand:    (method: string, nodeId: string, params?: Record<string, unknown>) => void;
  onRename:     (nodeId: string, label: string) => void;
  onMoveToGroup:(nodeId: string, group: AmaranFixtureGroup) => void;
}

function FixtureTile({
  fixture, state, label, group, loading, isAdmin, open, onOpen, onClose,
  onCommand, onRename, onMoveToGroup,
}: FixtureTileProps) {
  const { hasHSI, cctMin, cctMax } = useCaps(fixture);
  const id = fixture.nodeId;

  const [mode,       setMode]       = useState<AmaranColorMode>(state?.mode ?? 'cct');
  const [intensity,  setIntensity]  = useState(state?.brightness ?? 50);
  const [cct,        setCct]        = useState(() => {
    const v = state?.cct ?? Math.round((cctMin + cctMax) / 2);
    return Math.max(cctMin, Math.min(cctMax, v));
  });
  const [hue,        setHue]        = useState(state?.hue        ?? 0);
  const [saturation, setSaturation] = useState(state?.saturation ?? 100);
  const [editing,    setEditing]    = useState(false);
  const [nameDraft,  setNameDraft]  = useState(label);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Suppress server-state sync for 2s after the user touches a control so
  // Amaran status pushes don't blip a slider mid-interaction. Mirrors the
  // original FixtureRow behaviour.
  const lastTouchedAt = useRef<number>(0);
  const touch = () => { lastTouchedAt.current = Date.now(); };
  const recentlyTouched = () => Date.now() - lastTouchedAt.current < 2000;

  // Drag-to-dim: a vertical drag anywhere on the tile sets brightness directly,
  // no need to open the sheet. Glow follows live; one command commits on release
  // (mirrors FillSlider — never floods the Amaran queue). A plain tap still opens.
  const dragRef = useRef<{ id: number; startY: number; startBri: number; active: boolean }>({ id: -1, startY: 0, startBri: 0, active: false });
  const liveBriRef = useRef(0);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (state?.mode != null) setMode(state.mode);
    if (recentlyTouched()) return;
    if (state?.brightness != null) setIntensity(state.brightness);
    if (state?.cct        != null) setCct(Math.max(cctMin, Math.min(cctMax, state.cct)));
    if (state?.hue        != null) setHue(state.hue);
    if (state?.saturation != null) setSaturation(state.saturation);
  }, [state, cctMin, cctMax]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setNameDraft(label); }, [label]);
  useEffect(() => { if (editing) nameInputRef.current?.select(); }, [editing]);

  // Close the sheet on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const isPowered = state?.power === true;
  const glow = glowColor(mode, cct, hue, saturation, hasHSI);

  function togglePower() {
    touch();
    onCommand('setPower', id, { on: !isPowered });
  }

  function commitRename() {
    const t = nameDraft.trim();
    if (t && t !== label) onRename(id, t); else setNameDraft(label);
    setEditing(false);
  }

  function commitCCT(kelvin: number) {
    touch(); setMode('cct');
    if (isPowered) onCommand('setCCT', id, { kelvin });
  }

  function setColorMode() {
    touch(); setMode('hsi');
    if (isPowered) onCommand('setHSI', id, { hue, saturation, brightness: intensity });
  }

  function handleColorWheel(newHue: number, newSat: number) {
    touch(); setHue(newHue); setSaturation(newSat); setMode('hsi');
    if (isPowered) onCommand('setHSI', id, { hue: newHue, saturation: newSat, brightness: intensity });
  }

  function tilePointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('.lp-tile-pw')) return; // power dot handles itself
    suppressClickRef.current = false;
    dragRef.current = { id: e.pointerId, startY: e.clientY, startBri: intensity, active: false };
  }
  function tilePointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (d.id !== e.pointerId) return;
    const dy = d.startY - e.clientY; // up = brighter
    if (!d.active) {
      if (Math.abs(dy) < 6 || !isPowered) return; // engage only on a clear vertical drag of a lit fixture
      d.active = true;
      suppressClickRef.current = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    const next = Math.max(2, Math.min(100, Math.round(d.startBri + dy * (100 / 160))));
    liveBriRef.current = next;
    touch();
    setIntensity(next);
  }
  function tilePointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    if (d.id !== e.pointerId) return;
    dragRef.current = { ...d, id: -1 };
    if (d.active && isPowered) onCommand('setBrightness', id, { pct: liveBriRef.current });
  }
  function tileClick() {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; } // consumed by a drag
    onOpen(id);
  }

  const stateText = isPowered
    ? `${Math.round(intensity)}%  ·  ${hasHSI && mode === 'hsi' ? 'Colour' : `${cct}K`}`
    : 'Off';

  const fillHeight = isPowered ? `${Math.max(12, Math.round(intensity))}%` : '0%';

  return (
    <>
      <div
        className={`lp-tile${isPowered ? ' lp-tile--on' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${label} — ${stateText}. Drag to dim, tap to open controls`}
        onClick={tileClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(id); } }}
        onPointerDown={tilePointerDown}
        onPointerMove={tilePointerMove}
        onPointerUp={tilePointerUp}
        onPointerCancel={tilePointerUp}
        style={{
          borderColor: isPowered ? glow : undefined,
          boxShadow: isPowered ? `0 8px 30px -12px ${glow}` : undefined,
        }}
      >
        <span
          className="lp-tile-fill"
          style={{ height: fillHeight, background: glow, opacity: isPowered ? 0.55 : 0.12 }}
        />
        <span className="lp-tile-veil" />
        <span className="lp-tile-c">
          <span className="lp-tile-top">
            <span className={`lp-tile-ico${hasHSI ? ' lp-tile-ico--rgb' : ''}`}><BulbIcon /></span>
            <button
              type="button"
              className="lp-tile-pw"
              onClick={(e) => { e.stopPropagation(); togglePower(); }}
              disabled={loading}
              aria-label={isPowered ? 'Turn off' : 'Turn on'}
            >
              <TilePowerGlyph />
            </button>
          </span>
          <span className="lp-tile-body">
            <span className="lp-tile-name">{label}</span>
            <span className="lp-tile-state">{stateText}</span>
          </span>
        </span>
      </div>

      {open && createPortal(
        <div className="lp-sheet-backdrop lp-sheet-backdrop--show" onClick={onClose}>
          <div className="lp-sheet lp-sheet--show" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${label} controls`}>
            <div className="lp-sheet-grabber" />

            <div className="lp-sheet-head">
              <span className="lp-sheet-glow" style={{ background: isPowered ? glow : 'var(--surface-raised)', color: glow }} />
              <div className="lp-sheet-titles">
                {editing ? (
                  <input
                    ref={nameInputRef}
                    className="lp-fixture-name-input"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')  commitRename();
                      if (e.key === 'Escape') { e.stopPropagation(); setNameDraft(label); setEditing(false); }
                    }}
                  />
                ) : (
                  <button type="button" className="lp-sheet-title" onClick={() => setEditing(true)} title="Rename">
                    {label}
                  </button>
                )}
                <span className="lp-sheet-meta">{fixture.name} · {fixture.id}</span>
              </div>
              <button
                type="button"
                className={`lp-tile-pw lp-sheet-power${isPowered ? ' lp-tile--on' : ''}`}
                onClick={togglePower}
                disabled={loading}
                aria-label={isPowered ? 'Turn off' : 'Turn on'}
              >
                <TilePowerGlyph />
              </button>
              <button type="button" className="lp-sheet-close" onClick={onClose} aria-label="Close"><CloseIcon /></button>
            </div>

            <div className="lp-sheet-label"><span>Brightness</span><span>{Math.round(intensity)}%</span></div>
            <FillSlider
              value={intensity} min={0} max={100} label=""
              fillColor="rgba(255,255,255,0.9)"
              onChange={(v) => { touch(); setIntensity(v); }}
              onCommit={(v) => { if (isPowered) onCommand('setBrightness', id, { pct: v }); }}
            />

            {hasHSI && (
              <div className="lp-mode-seg">
                <button type="button" className={mode === 'cct' ? 'lp-mode-seg--on' : ''} onClick={() => commitCCT(cct)}>White</button>
                <button type="button" className={mode === 'hsi' ? 'lp-mode-seg--on' : ''} onClick={setColorMode}>Colour</button>
              </div>
            )}

            {(!hasHSI || mode === 'cct') && (
              <>
                <div className="lp-sheet-label"><span>Colour temperature</span><span>{cct}K</span></div>
                <FillSlider
                  value={cct} min={cctMin} max={cctMax} step={100} label=""
                  fillColor={cctFillColor(cct)}
                  onChange={(v) => { touch(); setCct(v); }}
                  onCommit={commitCCT}
                />
              </>
            )}

            {hasHSI && mode === 'hsi' && (
              <div className="lp-sheet-wheel">
                <ColorWheel hue={hue} saturation={saturation} active onChange={handleColorWheel} />
              </div>
            )}

            {isAdmin && (
              <div className="lp-reassign">
                <span className="lp-reassign-label">Room</span>
                <div className="lp-reassign-opts">
                  {AMARAN_GROUPS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`lp-reassign-opt${group === g ? ' lp-reassign-opt--on' : ''}`}
                      onClick={() => { if (group !== g) onMoveToGroup(id, g); }}
                    >
                      {GROUP_LABELS[g]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Ordering helper ───────────────────────────────────────────────────────────

function orderedRoomFixtures(
  group:    AmaranFixtureGroup,
  fixtures: AmaranFixture[],
  fixtureGroups: Record<string, AmaranFixtureGroup>,
  fixtureOrder:  Record<AmaranFixtureGroup, string[]>,
): AmaranFixture[] {
  const ordered  = fixtureOrder[group] ?? [];
  const inGroup  = fixtures.filter((f) => fixtureGroups[f.nodeId] === group);
  const unordered = inGroup.filter((f) => !ordered.includes(f.nodeId));
  return [
    ...ordered.map((nid) => inGroup.find((f) => f.nodeId === nid)).filter(Boolean) as AmaranFixture[],
    ...unordered,
  ];
}

// ── LightingPanel ─────────────────────────────────────────────────────────────

export function LightingPanel({ isAdmin }: { isAdmin: boolean }) {
  const {
    status, loading, error, arrangement,
    sendCommand, syncStatus, refreshHardware, connect, disconnect, rediscover,
    renameFixture, moveFixtureToGroup,
  } = useLighting();

  const [refreshing, setRefreshing] = useState(false);
  const [bulkBusy,   setBulkBusy]   = useState(false);
  const [openNode,   setOpenNode]   = useState<string | null>(null);

  async function handleRefresh() {
    setRefreshing(true);
    await rediscover();
    setRefreshing(false);
  }

  /** Turn every fixture on or off. Sequential — the Amaran service keys pending
   *  requests by action only, so concurrent setPower calls would collide on the
   *  shared 'set_sleep' key. */
  async function handleAllPower(on: boolean) {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      for (const f of fixtures) {
        await sendCommand('setPower', f.nodeId, { on });
      }
      // Include the bookshelf WLED strip in the master switch.
      if (wledPowerRef.current) {
        try { await wledPowerRef.current(on); } catch { /* non-fatal */ }
      }
    } finally {
      setBulkBusy(false);
    }
  }

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [portDraft,    setPortDraft]    = useState('33782');
  const [wledIpDraft,  setWledIpDraft]  = useState('');

  // ── Presets ────────────────────────────────────────────────────────────────
  const { presets, applying, savePreset, updatePreset, deletePreset, applyPreset } = useLightingPresets();
  const [presetsOpen,   setPresetsOpen]   = useState(false);
  const [editingPreset, setEditingPreset] = useState<{ id: string; name: string } | null>(null);
  const [nameDialog,    setNameDialog]    = useState(false);

  const wledSnapshotRef = useRef<(() => PresetWledState) | null>(null);
  // The bookshelf WLED strip participates in the master switch: it reports its
  // power up (for the "any on" tint) and exposes a setPower the master calls.
  const [wledPower, setWledPower] = useState<boolean | null>(null);
  const wledPowerRef = useRef<((on: boolean) => Promise<void>) | null>(null);

  const [saveWarning, setSaveWarning] = useState<{
    fixtures: { label: string; reason: string }[];
    proceed:  () => void;
  } | null>(null);

  function labelFor(nodeId: string): string {
    return arrangement.fixtureLabels[nodeId]
      ?? status?.fixtures.find((f) => f.nodeId === nodeId)?.name
      ?? nodeId;
  }

  async function captureAndGuard(commit: (snap: {
    amaran: ReturnType<typeof snapshotAmaran>; wled: PresetWledState | null;
  }) => void) {
    const fresh  = (await refreshHardware()) ?? status;
    const snap   = { amaran: snapshotAmaran(fresh), wled: wledSnapshotRef.current?.() ?? null };
    const issues = findIncompleteFixtures(fresh);
    if (issues.length > 0) {
      setNameDialog(false);
      setSaveWarning({
        fixtures: issues.map((i) => ({ label: labelFor(i.nodeId), reason: i.reason })),
        proceed:  () => { setSaveWarning(null); commit(snap); },
      });
      return;
    }
    commit(snap);
  }

  function handleSavePreset(name: string) {
    void captureAndGuard(({ amaran, wled }) => {
      void savePreset(name, amaran, wled);
      setNameDialog(false);
      setPresetsOpen(false);
    });
  }

  function handleUpdatePreset() {
    if (!editingPreset) return;
    const target = editingPreset;
    void captureAndGuard(({ amaran, wled }) => {
      void updatePreset(target.id, target.name, amaran, wled);
      setEditingPreset(null);
    });
  }

  function handleApplyPreset(id: string) {
    void applyPreset(id).then(() => {
      // Pull true hardware state after the sequential apply finishes; give the
      // last fixture's wake delay time to settle before syncing.
      setTimeout(() => void syncStatus(), 1500);
    });
  }

  useEffect(() => {
    fetch('/api/studio/lighting/config')
      .then((r) => r.json())
      .then((d: { config?: { port: number } }) => { if (d.config?.port) setPortDraft(String(d.config.port)); })
      .catch(() => {});
    fetch('/api/studio/wled/config')
      .then((r) => r.json())
      .then((d: { config?: { ip: string } }) => { if (d.config?.ip) setWledIpDraft(d.config.ip); })
      .catch(() => {});
  }, []);

  async function handleConnect() { await connect(parseInt(portDraft, 10) || 33782); }

  async function handleSaveSettings() {
    await Promise.all([
      fetch('/api/studio/lighting/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: parseInt(portDraft, 10) || 33782 }),
      }),
      fetch('/api/studio/wled/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: wledIpDraft.trim() }),
      }),
    ]);
    setSettingsOpen(false);
  }

  const connected = status?.connected ?? false;
  const fixtures  = status?.fixtures  ?? [];

  const showSections = connected || fixtures.length > 0;
  const ungrouped = fixtures.filter((f) => !arrangement.fixtureGroups[f.nodeId]);
  const anyOn = fixtures.some((f) => status?.states[f.nodeId]?.power === true) || wledPower === true;

  function renderTile(fixture: AmaranFixture) {
    return (
      <FixtureTile
        key={fixture.nodeId}
        fixture={fixture}
        state={status?.states[fixture.nodeId]}
        label={arrangement.fixtureLabels[fixture.nodeId] ?? fixture.name}
        group={arrangement.fixtureGroups[fixture.nodeId]}
        loading={loading}
        isAdmin={isAdmin}
        open={openNode === fixture.nodeId}
        onOpen={setOpenNode}
        onClose={() => setOpenNode(null)}
        onCommand={sendCommand}
        onRename={renameFixture}
        onMoveToGroup={moveFixtureToGroup}
      />
    );
  }

  return (
    <div className="lp-lighting-tab">

      {/* ═══ Floating edit bar ═══ */}
      {editingPreset && (
        <EditingBar
          presetName={editingPreset.name}
          onUpdate={handleUpdatePreset}
          onCancel={() => setEditingPreset(null)}
        />
      )}

      {/* ═══ Presets management modal ═══ */}
      {presetsOpen && (
        <PresetsModal
          presets={presets}
          applying={applying}
          onApply={handleApplyPreset}
          onAdd={() => setNameDialog(true)}
          onEdit={(p) => { setEditingPreset({ id: p.id, name: p.name }); setPresetsOpen(false); }}
          onDelete={(p) => void deletePreset(p.id)}
          onClose={() => setPresetsOpen(false)}
        />
      )}

      {nameDialog && (
        <NameDialog
          initial="Untitled Preset"
          onConfirm={handleSavePreset}
          onCancel={() => setNameDialog(false)}
        />
      )}

      {saveWarning && (
        <SaveWarningDialog
          fixtures={saveWarning.fixtures}
          onSaveAnyway={saveWarning.proceed}
          onCancel={() => setSaveWarning(null)}
        />
      )}

      {/* ═══ Panel header ═══ */}
      <div className="st-head">
        <span className="st-head-title">Lighting Control</span>
      </div>

      {/* ═══ Top control line: [dot] [gear] [Presets] … [All lights] ═══ */}
      <div className="lp-topline">
        <span className={`lp-lighting-dot${connected ? ' lp-lighting-dot--on' : ''}`} title={connected ? 'Connected' : 'Not connected'} />
        <button
          type="button"
          className={`at-gear${settingsOpen ? ' at-gear--active' : ''}`}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="Lighting settings"
        >
          <GearIcon />
        </button>
        {showSections && (
          <button
            type="button"
            className="lp-scene lp-topline-presets"
            onClick={() => setPresetsOpen(true)}
            title="Apply, save, or edit presets"
          >
            Presets
          </button>
        )}
        {showSections && (
          <button
            type="button"
            className={`lp-master-c lp-topline-master${anyOn ? ' lp-master-c--on' : ''}`}
            onClick={() => void handleAllPower(!anyOn)}
            disabled={bulkBusy || (fixtures.length === 0 && wledPower === null)}
            aria-pressed={anyOn}
            title={anyOn ? 'Turn all lights off' : 'Turn all lights on'}
          >
            <span className="lp-master-pg"><TilePowerGlyph /></span>
            <span className="lp-master-label">{bulkBusy ? 'Working…' : 'All lights'}</span>
          </button>
        )}
      </div>

      {error && <p className="lp-lighting-error">{error}</p>}

      {!connected && (
        <div className="lp-lighting-placeholder">
          <p className="lp-lighting-hint">Open Amaran Desktop, ensure your lights are paired, then open settings (gear) to connect.</p>
        </div>
      )}

      {/* ═══ Settings modal — mirrors the ATEM settings chrome ═══ */}
      {settingsOpen && createPortal(
        <div className="at-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="at-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Lighting settings">
            <div className="at-sheet-head">
              <h3>Lighting settings</h3>
              <button className="at-sheet-close" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close"><CloseIcon /></button>
            </div>

            {/* Connection */}
            <div className="at-set-block">
              <div className="at-set-label">
                <div className="t">Connection</div>
                <div className="s">Amaran Desktop link{connected ? ' — connected' : ' — not connected'}</div>
              </div>
              <div className="at-set-btns">
                {connected ? (
                  <>
                    <button type="button" className="at-btn at-btn--icon-text" onClick={() => void handleRefresh()} disabled={refreshing}>
                      <RefreshIcon spinning={refreshing} />
                      {refreshing ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <button type="button" className="at-btn" onClick={() => void disconnect()}>Disconnect</button>
                  </>
                ) : (
                  <button type="button" className="at-btn at-btn--pri" onClick={() => void handleConnect()}>Connect</button>
                )}
              </div>
            </div>

            {/* Amaran port */}
            <div className="at-set-block">
              <div className="at-set-label">
                <div className="t">Amaran Desktop port</div>
                <div className="s">WebSocket port (default 33782)</div>
              </div>
              <input
                className="at-input"
                type="number" min={1024} max={65535}
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveSettings(); }}
                placeholder="33782"
              />
            </div>

            {/* WLED IP */}
            <div className="at-set-block">
              <div className="at-set-label">
                <div className="t">WLED device IP</div>
                <div className="s">Bookshelf LED controller address</div>
              </div>
              <input
                className="at-input"
                type="text"
                value={wledIpDraft}
                onChange={(e) => setWledIpDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveSettings(); }}
                placeholder="192.168.1.50"
              />
              <div className="at-set-btns">
                <button type="button" className="at-btn at-btn--pri" onClick={() => void handleSaveSettings()}>Save</button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ═══ Unassigned ═══ */}
      {showSections && ungrouped.length > 0 && (
        <div className="lp-lighting-section">
          <div className="lp-lighting-section-header lp-lighting-section-header--named">
            <div className="lp-lighting-section-header-left">Unassigned</div>
            <span className="lp-lighting-section-count">{ungrouped.length}</span>
          </div>
          <div className="lp-tile-grid">
            {ungrouped.map(renderTile)}
          </div>
          {isAdmin && (
            <p className="lp-lighting-hint" style={{ marginTop: 4 }}>
              Open a light and use its Room control to file it under Bookshelves, Void, or Mobile.
            </p>
          )}
        </div>
      )}

      {/* ═══ Named rooms ═══ */}
      {showSections && AMARAN_GROUPS.map((group) => {
        const roomFixtures = orderedRoomFixtures(group, fixtures, arrangement.fixtureGroups, arrangement.fixtureOrder);
        const showWled = group === 'bookshelves';
        if (roomFixtures.length === 0 && !showWled) {
          return (
            <div className="lp-lighting-section" key={group}>
              <div className="lp-lighting-section-header lp-lighting-section-header--named">
                <div className="lp-lighting-section-header-left">{GROUP_LABELS[group]}</div>
                <span className="lp-lighting-section-count">0</span>
              </div>
              <p className="lp-lighting-hint lp-lighting-section-empty">No fixtures in this room.</p>
            </div>
          );
        }
        return (
          <div className="lp-lighting-section" key={group}>
            <div className="lp-lighting-section-header lp-lighting-section-header--named">
              <div className="lp-lighting-section-header-left">{GROUP_LABELS[group]}</div>
              <span className="lp-lighting-section-count">{roomFixtures.length + (showWled ? 1 : 0)}</span>
            </div>
            <div className="lp-tile-grid">
              {roomFixtures.map(renderTile)}
              {showWled && <WledTile snapshotRef={wledSnapshotRef} controlRef={wledPowerRef} onPowerChange={setWledPower} />}
            </div>
          </div>
        );
      })}

    </div>
  );
}
