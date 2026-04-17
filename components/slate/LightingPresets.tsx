'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LightingPreset } from '@/hooks/useLightingPresets';

// ── Context menu ──────────────────────────────────────────────────────────────

interface ContextMenuProps {
  x:        number;
  y:        number;
  preset:   LightingPreset;
  onEdit:   (preset: LightingPreset) => void;
  onDelete: (preset: LightingPreset) => void;
  onClose:  () => void;
}

function ContextMenu({ x, y, preset, onEdit, onDelete, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [onClose]);

  // Adjust so menu stays on screen
  const style: React.CSSProperties = {
    position: 'fixed',
    left: x,
    top:  y,
    zIndex: 9999,
  };

  return createPortal(
    <div ref={ref} className="lp-preset-context-menu" style={style}>
      <button
        type="button"
        className="lp-preset-context-item"
        onMouseDown={() => { onEdit(preset); onClose(); }}
      >
        Edit preset
      </button>
      <button
        type="button"
        className="lp-preset-context-item lp-preset-context-item--danger"
        onMouseDown={() => { onDelete(preset); onClose(); }}
      >
        Delete preset
      </button>
    </div>,
    document.body,
  );
}

// ── Add preset name dialog ────────────────────────────────────────────────────

interface NameDialogProps {
  initial:    string;
  onConfirm:  (name: string) => void;
  onCancel:   () => void;
}

export function NameDialog({ initial, onConfirm, onCancel }: NameDialogProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);

  return createPortal(
    <div className="lp-preset-name-overlay">
      <div className="lp-preset-name-dialog">
        <p className="lp-preset-name-label">Preset name</p>
        <input
          ref={inputRef}
          className="lp-lighting-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter')  onConfirm(value.trim() || initial);
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="e.g. Interview"
          autoFocus
        />
        <div className="lp-preset-name-actions">
          <button type="button" className="lp-lighting-btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="lp-lighting-btn lp-lighting-btn--accent"
            onClick={() => onConfirm(value.trim() || initial)}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Presets modal ─────────────────────────────────────────────────────────────

export interface PresetsModalProps {
  presets:       LightingPreset[];
  applying:      string | null;
  onApply:       (id: string) => void;
  onAdd:         () => void;
  onEdit:        (preset: LightingPreset) => void;
  onDelete:      (preset: LightingPreset) => void;
  onClose:       () => void;
}

export function PresetsModal({
  presets, applying, onApply, onAdd, onEdit, onDelete, onClose,
}: PresetsModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; preset: LightingPreset } | null>(null);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  function handleContextMenu(e: React.MouseEvent, preset: LightingPreset) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, preset });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div
        ref={overlayRef}
        className="lp-preset-modal-overlay"
        onClick={handleOverlayClick}
      >
        <div className="lp-preset-modal">
          <div className="lp-preset-modal-header">
            <span>Presets</span>
            <button type="button" className="lp-preset-modal-close" onClick={onClose} aria-label="Close">✕</button>
          </div>

          <div className="lp-preset-modal-body">
            {presets.length === 0 && (
              <p className="lp-lighting-hint">No presets yet. Save the current setup with the button below.</p>
            )}
            <div className="lp-preset-grid">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`lp-preset-btn${applying === p.id ? ' lp-preset-btn--applying' : ''}`}
                  onClick={() => onApply(p.id)}
                  onContextMenu={(e) => handleContextMenu(e, p)}
                  title="Click to apply • Right-click to edit or delete"
                >
                  {applying === p.id ? (
                    <span className="lp-preset-btn-applying">Applying…</span>
                  ) : (
                    <span>{p.name}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="lp-preset-modal-footer">
            <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={onAdd}>
              + Save current as preset
            </button>
          </div>
        </div>
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          preset={ctxMenu.preset}
          onEdit={onEdit}
          onDelete={onDelete}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>,
    document.body,
  );
}

// ── Floating edit bar ─────────────────────────────────────────────────────────

export interface EditingBarProps {
  presetName: string;
  onUpdate:   () => void;
  onCancel:   () => void;
}

export function EditingBar({ presetName, onUpdate, onCancel }: EditingBarProps) {
  return (
    <div className="lp-preset-editing-bar">
      <span className="lp-preset-editing-label">
        Editing: <strong>{presetName}</strong>
      </span>
      <div className="lp-preset-editing-actions">
        <button type="button" className="lp-lighting-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="lp-lighting-btn lp-lighting-btn--accent" onClick={onUpdate}>
          Update Preset
        </button>
      </div>
    </div>
  );
}

// ── Preset trigger button ─────────────────────────────────────────────────────

export interface PresetsTriggerProps {
  onClick: () => void;
}

export function PresetsTrigger({ onClick }: PresetsTriggerProps) {
  return (
    <button type="button" className="lp-presets-trigger" onClick={onClick}>
      Presets
    </button>
  );
}

// ── Orchestrator: wires everything together for LightingPanel ─────────────────

export interface LightingPresetsControllerProps {
  presets:      LightingPreset[];
  applying:     string | null;
  onApply:      (id: string) => void;
  onSave:       (name: string) => void;
  onUpdate:     (id: string, name: string) => void;
  onDelete:     (id: string) => void;
}

export function useLightingPresetsUI(props: LightingPresetsControllerProps) {
  const { presets, applying, onApply, onSave, onUpdate, onDelete } = props;

  const [modalOpen,    setModalOpen]    = useState(false);
  const [editingPreset, setEditingPreset] = useState<LightingPreset | null>(null);
  const [nameDialog,   setNameDialog]   = useState<{ mode: 'add' } | null>(null);

  const handleAdd = useCallback(() => {
    setNameDialog({ mode: 'add' });
  }, []);

  const handleNameConfirm = useCallback((name: string) => {
    onSave(name);
    setNameDialog(null);
    setModalOpen(false);
  }, [onSave]);

  const handleEdit = useCallback((preset: LightingPreset) => {
    setEditingPreset(preset);
    setModalOpen(false);
  }, []);

  const handleDelete = useCallback((preset: LightingPreset) => {
    onDelete(preset.id);
  }, [onDelete]);

  const handleUpdatePreset = useCallback(() => {
    if (!editingPreset) return;
    onUpdate(editingPreset.id, editingPreset.name);
    setEditingPreset(null);
  }, [editingPreset, onUpdate]);

  const handleCancelEdit = useCallback(() => {
    setEditingPreset(null);
  }, []);

  return {
    modalOpen,
    editingPreset,
    nameDialog,
    setModalOpen,
    handleAdd,
    handleNameConfirm,
    handleEdit,
    handleDelete,
    handleUpdatePreset,
    handleCancelEdit,
    // Passthrough
    presets,
    applying,
    onApply,
    NameDialog,
    PresetsModal,
    EditingBar,
    PresetsTrigger,
  };
}
