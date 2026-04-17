'use client';

import { useRef } from 'react';

// ── Shared lighting control primitives ───────────────────────────────────────
// Used by both LightingPanel (Amaran) and WledPanel (WLED).

export function PowerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64"/>
      <line x1="12" y1="2" x2="12" y2="12"/>
    </svg>
  );
}

export function cctFillColor(kelvin: number): string {
  const t = Math.max(0, Math.min(1, (kelvin - 2500) / 5000));
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const u = t * 2;
    r = 255; g = Math.round(140 + u * (222 - 140)); b = Math.round(u * 158);
  } else {
    const u = (t - 0.5) * 2;
    r = Math.round(255 - u * (255 - 201)); g = Math.round(222 + u * (232 - 222)); b = Math.round(158 + u * (255 - 158));
  }
  return `rgb(${r},${g},${b})`;
}

export interface FillSliderProps {
  value:     number;
  min:       number;
  max:       number;
  label:     string;
  fillColor: string;
  step?:     number;
  onChange:  (v: number) => void;
  onCommit:  (v: number) => void;
}

export function FillSlider({ value, min, max, label, fillColor, step = 1, onChange, onCommit }: FillSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging     = useRef(false);
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  function snap(v: number): number {
    return Math.round(Math.round(v / step) * step * 10) / 10;
  }

  function valueFromPointer(e: React.PointerEvent): number {
    const el = containerRef.current;
    if (!el) return value;
    const rect  = el.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    return snap(min + Math.max(0, Math.min(1, ratio)) * (max - min));
  }

  function onPointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    onChange(valueFromPointer(e));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    onChange(valueFromPointer(e));
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!dragging.current) return;
    dragging.current = false;
    const v = valueFromPointer(e);
    onChange(v);
    onCommit(v);
  }

  return (
    <div className="lp-fill-slider-wrap">
      <div
        ref={containerRef}
        className="lp-fill-slider"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="lp-fill-slider-fill" style={{ width: `${pct}%`, background: fillColor }} />
      </div>
      <span className="lp-fixture-slider-label">{label}</span>
    </div>
  );
}
