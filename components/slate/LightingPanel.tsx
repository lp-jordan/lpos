'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AmaranFixture, AmaranFixtureState, AmaranColorMode } from '@/lib/services/amaran-service';
import { useLighting } from '@/hooks/useLighting';
import { AMARAN_GROUPS, GROUP_LABELS, type AmaranFixtureGroup } from '@/lib/lighting-constants';
import { WledPanel } from '@/components/slate/WledPanel';
import { FillSlider, cctFillColor, PowerIcon } from '@/components/slate/lighting-controls';
import { useLightingPresets, snapshotAmaran } from '@/hooks/useLightingPresets';
import type { PresetWledState } from '@/lib/store/lighting-presets-store';
import {
  PresetsModal, EditingBar, PresetsTrigger, NameDialog,
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


function DragHandleIcon() {
  return (
    <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
      <circle cx="4" cy="3"  r="1.5"/>
      <circle cx="8" cy="3"  r="1.5"/>
      <circle cx="4" cy="8"  r="1.5"/>
      <circle cx="8" cy="8"  r="1.5"/>
      <circle cx="4" cy="13" r="1.5"/>
      <circle cx="8" cy="13" r="1.5"/>
    </svg>
  );
}


// ── ColorWheel ────────────────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

interface ColorWheelProps {
  hue: number; saturation: number; active: boolean;
  onChange: (hue: number, saturation: number) => void;
}

function ColorWheel({ hue, saturation, active, onChange }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const SIZE = 110; const R = SIZE / 2;

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
        data[idx] = r; data[idx+1] = g; data[idx+2] = b; data[idx+3] = active ? 255 : 140;
      }
    }
    ctx.putImageData(img, 0, 0);
    const selAngle = hue * Math.PI / 180, selDist = (saturation / 100) * R;
    const sx = R + Math.cos(selAngle) * selDist, sy = R + Math.sin(selAngle) * selDist;
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 2*Math.PI);
    ctx.strokeStyle = active ? '#fff' : 'rgba(255,255,255,0.45)'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 2*Math.PI);
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
    <canvas ref={canvasRef} width={SIZE} height={SIZE} className="lp-color-wheel"
      style={{ opacity: active ? 1 : 0.5 }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); getCoords(e); }}
      onPointerMove={(e) => { if (e.buttons > 0) getCoords(e); }}
    />
  );
}

// ── FixtureRow ────────────────────────────────────────────────────────────────

interface FixtureRowProps {
  fixture:         AmaranFixture;
  state:           AmaranFixtureState | undefined;
  label:           string;
  group:           AmaranFixtureGroup | undefined;
  loading:         boolean;
  isAdmin:         boolean;
  showGroupPicker: boolean;
  isDragging:      boolean;
  dragHandleProps: Record<string, unknown>;
  onCommand:       (method: string, nodeId: string, params?: Record<string, unknown>) => void;
  onRename:        (nodeId: string, label: string) => void;
  onMoveToGroup:   (nodeId: string, group: AmaranFixtureGroup) => void;
}

function useCaps(fixture: AmaranFixture) {
  return {
    hasHSI: fixture.capabilities?.hasHSI ?? true,
    cctMin: fixture.capabilities?.cctMin ?? 2500,
    cctMax: fixture.capabilities?.cctMax ?? 7500,
  };
}

function FixtureRow({
  fixture, state, label, group, loading, isAdmin, showGroupPicker, isDragging,
  dragHandleProps, onCommand, onRename, onMoveToGroup,
}: FixtureRowProps) {
  const { hasHSI, cctMin, cctMax } = useCaps(fixture);

  const [activeMode,  setActiveMode]  = useState<AmaranColorMode>(state?.mode ?? 'cct');
  const [intensity,   setIntensity]   = useState(state?.brightness ?? 50);
  const [cct,         setCct]         = useState(() => {
    const v = state?.cct ?? Math.round((cctMin + cctMax) / 2);
    return Math.max(cctMin, Math.min(cctMax, v));
  });
  const [hue,         setHue]         = useState(state?.hue        ?? 0);
  const [saturation,  setSaturation]  = useState(state?.saturation ?? 100);
  const [editing,     setEditing]     = useState(false);
  const [nameDraft,   setNameDraft]   = useState(label);
  const nameInputRef  = useRef<HTMLInputElement>(null);
  // Suppress server-state sync for 2s after the user touches a control,
  // preventing Amaran status pushes from blipping sliders mid-interaction.
  const lastTouchedAt = useRef<number>(0);
  const touch = () => { lastTouchedAt.current = Date.now(); };
  const recentlyTouched = () => Date.now() - lastTouchedAt.current < 2000;

  useEffect(() => {
    if (recentlyTouched()) return;
    if (state?.mode       != null) setActiveMode(state.mode);
    if (state?.brightness != null) setIntensity(state.brightness);
    if (state?.cct        != null) setCct(Math.max(cctMin, Math.min(cctMax, state.cct)));
    if (state?.hue        != null) setHue(state.hue);
    if (state?.saturation != null) setSaturation(state.saturation);
  }, [state, cctMin, cctMax]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setNameDraft(label); }, [label]);
  useEffect(() => { if (editing) nameInputRef.current?.select(); }, [editing]);

  const id = fixture.nodeId;
  const isPowered = state?.power === true;

  function commitRename() {
    const t = nameDraft.trim();
    if (t && t !== label) onRename(id, t); else setNameDraft(label);
    setEditing(false);
  }

  function commitCCT(kelvin: number) {
    touch();
    setActiveMode('cct');
    if (isPowered) onCommand('setCCT', id, { kelvin });
  }

  function handleColorWheel(newHue: number, newSat: number) {
    touch(); setHue(newHue); setSaturation(newSat); setActiveMode('hsi');
    if (isPowered) onCommand('setHSI', id, { hue: newHue, saturation: newSat, brightness: intensity });
  }

  return (
    <div className={`lp-fixture-row${!isPowered ? ' lp-fixture-row--off' : ''}${isDragging ? ' lp-fixture-row--dragging' : ''}`}>

      {/* Header */}
      <div className="lp-fixture-row-header">

        {/* Drag handle */}
        <span className="lp-fixture-drag-handle" {...dragHandleProps} aria-label="Drag to reorder">
          <DragHandleIcon />
        </span>

        <span className={`lp-lighting-dot${isPowered ? ' lp-lighting-dot--on' : ''}`} />

        {editing ? (
          <input
            ref={nameInputRef}
            className="lp-fixture-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter')  commitRename();
              if (e.key === 'Escape') { setNameDraft(label); setEditing(false); }
            }}
          />
        ) : (
          <button type="button" className="lp-fixture-name-btn" onClick={() => setEditing(true)} title="Click to rename">
            {label}
          </button>
        )}

        <span className="lp-fixture-row-id">{fixture.id}</span>

        {/* Section picker — admin only, when arrangement mode is on */}
        {isAdmin && showGroupPicker && (
          <select
            className="lp-fixture-group-select"
            value={group ?? ''}
            onChange={(e) => { if (e.target.value) onMoveToGroup(id, e.target.value as AmaranFixtureGroup); }}
            title="Move to section"
          >
            <option value="" disabled>Move to…</option>
            {AMARAN_GROUPS.map((g) => (
              <option key={g} value={g}>{GROUP_LABELS[g]}</option>
            ))}
          </select>
        )}
      </div>

      {/* Controls */}
      <div className="lp-fixture-row-controls">
        <button
          type="button"
          className={`lp-fixture-power-btn${isPowered ? ' lp-fixture-power-btn--on' : ''}`}
          onClick={() => { touch(); onCommand('setPower', id, { on: !isPowered }); }}
          disabled={loading}
          aria-label={isPowered ? 'Turn off' : 'Turn on'}
        >
          <PowerIcon />
          <span>{isPowered ? 'ON' : 'OFF'}</span>
        </button>

        <div className="lp-fixture-row-sliders">
          <FillSlider
            value={intensity} min={0} max={100} label={`${intensity}%`}
            fillColor="rgba(255,255,255,0.88)"
            onChange={(v) => { touch(); setIntensity(v); }}
            onCommit={(v) => { if (isPowered) onCommand('setBrightness', id, { pct: v }); }}
          />
          <FillSlider
            value={cct} min={cctMin} max={cctMax} label={`${cct}K`}
            fillColor={cctFillColor(cct)}
            step={100}
            onChange={(v) => { touch(); setCct(v); }}
            onCommit={commitCCT}
          />
        </div>

        <div className={`lp-fixture-row-wheel${activeMode === 'hsi' ? ' lp-fixture-row-wheel--active' : ''}`}>
          {hasHSI && (
            <ColorWheel hue={hue} saturation={saturation} active={activeMode === 'hsi'} onChange={handleColorWheel} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── SortableFixtureRow — wraps FixtureRow with dnd-kit sortable ───────────────

interface SortableFixtureRowProps extends Omit<FixtureRowProps, 'isDragging' | 'dragHandleProps'> {
  id: string;
}

function SortableFixtureRow({ id, ...rest }: SortableFixtureRowProps) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    position: 'relative',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <FixtureRow
        {...rest}
        isDragging={isDragging}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ── Helpers: build ordered fixture list for a section ─────────────────────────

function buildSectionFixtures(
  group:    AmaranFixtureGroup | 'ungrouped',
  fixtures: AmaranFixture[],
  fixtureGroups: Record<string, AmaranFixtureGroup>,
  fixtureOrder:  Record<AmaranFixtureGroup, string[]>,
): AmaranFixture[] {
  if (group === 'ungrouped') {
    return fixtures.filter((f) => !fixtureGroups[f.nodeId]);
  }
  const ordered = fixtureOrder[group] ?? [];
  const inGroup  = fixtures.filter((f) => fixtureGroups[f.nodeId] === group);
  // Fixtures that are assigned to this group but not yet in the order array
  const unordered = inGroup.filter((f) => !ordered.includes(f.nodeId));
  // Return in stored order, then append any newly discovered fixtures
  return [
    ...ordered.map((nid) => inGroup.find((f) => f.nodeId === nid)).filter(Boolean) as AmaranFixture[],
    ...unordered,
  ];
}

// ── FixtureSection ────────────────────────────────────────────────────────────

interface FixtureSectionProps {
  group:             AmaranFixtureGroup;
  fixtures:          AmaranFixture[];
  status:            ReturnType<typeof useLighting>['status'];
  arrangement:       ReturnType<typeof useLighting>['arrangement'];
  loading:           boolean;
  isAdmin:           boolean;
  showGroupPicker:   boolean;
  showWled?:         boolean;
  wledSnapshotRef?:  React.MutableRefObject<(() => PresetWledState) | null>;
  onCommand:         FixtureRowProps['onCommand'];
  onRename:          FixtureRowProps['onRename'];
  onMoveToGroup:     FixtureRowProps['onMoveToGroup'];
  onReorder:         (group: AmaranFixtureGroup, newOrder: string[]) => void;
}

function FixtureSection({
  group, fixtures, status, arrangement, loading, isAdmin, showGroupPicker, showWled,
  wledSnapshotRef, onCommand, onRename, onMoveToGroup, onReorder,
}: FixtureSectionProps) {
  const sectionFixtures = buildSectionFixtures(group, fixtures, arrangement.fixtureGroups, arrangement.fixtureOrder);
  const ids = sectionFixtures.map((f) => f.nodeId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(group, arrayMove(ids, oldIndex, newIndex));
  }

  return (
    <div className="lp-lighting-section">
      <div className="lp-lighting-section-header lp-lighting-section-header--named">
        <div className="lp-lighting-section-header-left">
          {GROUP_LABELS[group]}
        </div>
        <span className="lp-lighting-section-count">{sectionFixtures.length}</span>
      </div>

      {/* WLED panel lives inside Bookshelves */}
      {showWled && <WledPanel snapshotRef={wledSnapshotRef} />}

      {sectionFixtures.length === 0 ? (
        <p className="lp-lighting-hint lp-lighting-section-empty">
          {isAdmin ? 'No fixtures assigned — use the section picker on any fixture.' : 'No fixtures in this section.'}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="lp-fixture-rows">
              {sectionFixtures.map((fixture) => (
                <SortableFixtureRow
                  key={fixture.nodeId}
                  id={fixture.nodeId}
                  fixture={fixture}
                  state={status?.states[fixture.nodeId]}
                  label={arrangement.fixtureLabels[fixture.nodeId] ?? fixture.name}
                  group={arrangement.fixtureGroups[fixture.nodeId]}
                  loading={loading}
                  isAdmin={isAdmin}
                  showGroupPicker={showGroupPicker}
                  onCommand={onCommand}
                  onRename={onRename}
                  onMoveToGroup={onMoveToGroup}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

// ── LightingPanel ─────────────────────────────────────────────────────────────

export function LightingPanel({ isAdmin }: { isAdmin: boolean }) {
  const {
    status, loading, error, arrangement,
    sendCommand, connect, disconnect, rediscover,
    renameFixture, moveFixtureToGroup, reorderGroup,
  } = useLighting();

  const [refreshing,      setRefreshing]      = useState(false);
  const [arrangementMode, setArrangementMode] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    await rediscover();
    setRefreshing(false);
  }

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [portDraft,    setPortDraft]    = useState('33782');
  const [wledIpDraft,  setWledIpDraft]  = useState('');

  // ── Presets ────────────────────────────────────────────────────────────────
  const { presets, applying, savePreset, updatePreset, deletePreset, applyPreset } = useLightingPresets();
  const [presetsOpen,   setPresetsOpen]   = useState(false);
  const [editingPreset, setEditingPreset] = useState<{ id: string; name: string } | null>(null);
  const [nameDialog,    setNameDialog]    = useState(false);

  // WledPanel registers a getter so we can snapshot its current slider values
  const wledSnapshotRef = useRef<(() => PresetWledState) | null>(null);

  function captureSnapshot() {
    const amaran = snapshotAmaran(status);
    const wled   = wledSnapshotRef.current?.() ?? null;
    return { amaran, wled };
  }

  function handleSavePreset(name: string) {
    const { amaran, wled } = captureSnapshot();
    void savePreset(name, amaran, wled);
    setNameDialog(false);
    setPresetsOpen(false);
  }

  function handleUpdatePreset() {
    if (!editingPreset) return;
    const { amaran, wled } = captureSnapshot();
    void updatePreset(editingPreset.id, editingPreset.name, amaran, wled);
    setEditingPreset(null);
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

  // Fixtures not yet assigned to any group
  const ungrouped = fixtures.filter((f) => !arrangement.fixtureGroups[f.nodeId]);

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

      {/* ═══ Presets modal ═══ */}
      {presetsOpen && (
        <PresetsModal
          presets={presets}
          applying={applying}
          onApply={(id) => void applyPreset(id)}
          onAdd={() => setNameDialog(true)}
          onEdit={(p) => { setEditingPreset({ id: p.id, name: p.name }); setPresetsOpen(false); }}
          onDelete={(p) => void deletePreset(p.id)}
          onClose={() => setPresetsOpen(false)}
        />
      )}

      {/* ═══ Name dialog ═══ */}
      {nameDialog && (
        <NameDialog
          initial="Untitled Preset"
          onConfirm={handleSavePreset}
          onCancel={() => setNameDialog(false)}
        />
      )}

      {/* ═══ Amaran — connection header ═══ */}
      <div className="lp-lighting-section">
        <div className="lp-lighting-topbar-actions">
          <span className={`lp-lighting-dot${connected ? ' lp-lighting-dot--on' : ''}`} />
          {isAdmin && connected && (
            <button
              type="button"
              className={`lp-lighting-btn${arrangementMode ? ' lp-lighting-btn--active' : ''}`}
              onClick={() => setArrangementMode((v) => !v)}
              title="Toggle section assignment"
            >
              Arrange
            </button>
          )}
          {connected ? (
            <>
              <button
                type="button"
                className="lp-lighting-btn lp-lighting-btn--icon"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                title="Refresh fixtures"
              >
                <RefreshIcon spinning={refreshing} />
              </button>
              <button type="button" className="lp-lighting-btn lp-lighting-btn--muted" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={() => void handleConnect()}>
              Connect
            </button>
          )}
          <button
            type="button"
            className={`lp-lighting-btn lp-lighting-btn--icon${settingsOpen ? ' lp-lighting-btn--active' : ''}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Lighting settings"
          >
            <GearIcon />
          </button>
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
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveSettings(); }}
                placeholder="33782"
              />
            </div>
            <label className="lp-lighting-label" style={{ marginTop: 10 }}>WLED device IP</label>
            <div className="lp-lighting-settings-row">
              <input
                className="lp-lighting-input"
                type="text"
                value={wledIpDraft}
                onChange={(e) => setWledIpDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveSettings(); }}
                placeholder="192.168.1.50"
              />
            </div>
            <div className="lp-lighting-settings-row" style={{ marginTop: 8 }}>
              <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={() => void handleSaveSettings()}>
                Save
              </button>
            </div>
          </div>
        )}

        {error && <p className="lp-lighting-error">{error}</p>}

        {!connected && !settingsOpen && (
          <div className="lp-lighting-placeholder">
            <p className="lp-lighting-hint">Open Amaran Desktop, ensure your lights are paired, then click Connect.</p>
          </div>
        )}
      </div>

      {/* ═══ Presets trigger ═══ */}
      {connected && (
        <PresetsTrigger onClick={() => setPresetsOpen(true)} />
      )}

      {/* ═══ Ungrouped (unassigned) fixtures ═══ */}
      {connected && ungrouped.length > 0 && (
        <div className="lp-lighting-section">
          <div className="lp-lighting-section-header">
            <div className="lp-lighting-section-header-left">Unassigned</div>
            <span className="lp-lighting-section-count">{ungrouped.length}</span>
          </div>
          <div className="lp-fixture-rows">
            {ungrouped.map((fixture) => (
              <FixtureRow
                key={fixture.nodeId}
                fixture={fixture}
                state={status?.states[fixture.nodeId]}
                label={arrangement.fixtureLabels[fixture.nodeId] ?? fixture.name}
                group={undefined}
                loading={loading}
                isAdmin={isAdmin}
                showGroupPicker={arrangementMode}
                isDragging={false}
                dragHandleProps={{}}
                onCommand={sendCommand}
                onRename={renameFixture}
                onMoveToGroup={moveFixtureToGroup}
              />
            ))}
          </div>
          {isAdmin && (
            <p className="lp-lighting-hint" style={{ marginTop: 4 }}>
              Use the section picker on each fixture to assign it to Bookshelves, Void, or Mobile.
            </p>
          )}
        </div>
      )}

      {/* ═══ Named sections ═══ */}
      {connected && AMARAN_GROUPS.map((group) => (
        <FixtureSection
          key={group}
          group={group}
          fixtures={fixtures}
          status={status}
          arrangement={arrangement}
          loading={loading}
          isAdmin={isAdmin}
          showGroupPicker={arrangementMode}
          showWled={group === 'bookshelves'}
          wledSnapshotRef={group === 'bookshelves' ? wledSnapshotRef : undefined}
          onCommand={sendCommand}
          onRename={renameFixture}
          onMoveToGroup={moveFixtureToGroup}
          onReorder={reorderGroup}
        />
      ))}

    </div>
  );
}
