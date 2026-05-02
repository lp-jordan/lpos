'use client';

import { useEffect, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  value:        string | null;
  onChange:     (value: string | null) => void;
  placeholder?: string;
  mode?:        'date' | 'month';
  disabled?:    boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value + (value.length === 7 ? '-01' : ''));
  return isNaN(d.getTime()) ? null : d;
}

function formatDisplay(value: string | null, mode: 'date' | 'month'): string {
  const d = parseDate(value);
  if (!d) return '';
  if (mode === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function toISOMonth(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function toISODate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function firstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MonthYearPanel({
  year, month, onSelect, onYearChange,
}: {
  year: number; month: number;
  onSelect: (y: number, m: number) => void;
  onYearChange: (delta: number) => void;
}) {
  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button type="button" onClick={() => onYearChange(-1)} style={navBtnStyle}>‹</button>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-strong)' }}>{year}</span>
        <button type="button" onClick={() => onYearChange(1)} style={navBtnStyle}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
        {MONTHS.map((m, i) => (
          <button
            key={m}
            type="button"
            onClick={() => onSelect(year, i)}
            style={{
              ...monthBtnStyle,
              background: i === month ? 'var(--accent)' : 'transparent',
              color:       i === month ? '#fff' : 'var(--text)',
            }}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}

function DatePanel({
  year, month, selectedDate, onSelect, onNavMonth,
}: {
  year: number; month: number; selectedDate: Date | null;
  onSelect: (y: number, m: number, d: number) => void;
  onNavMonth: (delta: number) => void;
}) {
  const total = daysInMonth(year, month);
  const start = firstDayOfWeek(year, month);
  const cells: (number | null)[] = [...Array(start).fill(null), ...Array.from({ length: total }, (_, i) => i + 1)];
  const today = new Date();

  const isSel = (d: number) =>
    selectedDate &&
    selectedDate.getUTCFullYear() === year &&
    selectedDate.getUTCMonth() === month &&
    selectedDate.getUTCDate() === d;

  const isToday = (d: number) =>
    today.getFullYear() === year &&
    today.getMonth() === month &&
    today.getDate() === d;

  return (
    <div style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button type="button" onClick={() => onNavMonth(-1)} style={navBtnStyle}>‹</button>
        <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-strong)' }}>
          {MONTHS[month]} {year}
        </span>
        <button type="button" onClick={() => onNavMonth(1)} style={navBtnStyle}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {DAYS.map((d) => (
          <div key={d} style={{ textAlign: 'center', fontSize: '0.68rem', color: 'var(--muted-soft)', fontWeight: 600, paddingBottom: 4 }}>{d}</div>
        ))}
        {cells.map((d, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            {d != null ? (
              <button
                type="button"
                onClick={() => onSelect(year, month, d)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: isSel(d) ? 'var(--accent)' : 'transparent',
                  color:      isSel(d) ? '#fff' : isToday(d) ? 'var(--accent-strong)' : 'var(--text)',
                  fontWeight: isSel(d) || isToday(d) ? 700 : 400,
                  fontSize:   '0.8rem',
                }}
              >
                {d}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const navBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--muted)', fontSize: '1.1rem', lineHeight: 1,
  width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 6,
};

const monthBtnStyle: React.CSSProperties = {
  padding: '6px 4px', borderRadius: 6, border: 'none', cursor: 'pointer',
  fontSize: '0.8rem', fontWeight: 500, transition: 'background 100ms',
};

// ── Main component ────────────────────────────────────────────────────────────

export function DatePicker({ value, onChange, placeholder = 'Select date', mode = 'date', disabled = false }: Props) {
  const parsed = parseDate(value);
  const now    = new Date();

  const [open,     setOpen]     = useState(false);
  const [year,     setYear]     = useState(parsed?.getUTCFullYear() ?? now.getFullYear());
  const [month,    setMonth]    = useState(parsed?.getUTCMonth()    ?? now.getMonth());
  const [popupPos, setPopupPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const buttonRef    = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleOpenToggle() {
    if (disabled) return;
    if (!open) {
      if (parsed) {
        setYear(parsed.getUTCFullYear());
        setMonth(parsed.getUTCMonth());
      }
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPopupPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    setOpen((v) => !v);
  }

  function handleMonthSelect(y: number, m: number) {
    onChange(toISOMonth(y, m));
    setOpen(false);
  }

  function handleDateSelect(y: number, m: number, d: number) {
    onChange(toISODate(y, m, d));
    setOpen(false);
  }

  function handleNavMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth(m);
    setYear(y);
  }

  const display = formatDisplay(value, mode);

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpenToggle}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '0.35rem 0.6rem', borderRadius: 6,
          border: '1px solid var(--color-border,#444)',
          background: 'var(--color-input-bg,#1a1a1a)',
          color: display ? 'var(--text)' : 'var(--muted)',
          fontSize: '0.875rem', cursor: disabled ? 'default' : 'pointer',
          textAlign: 'left',
        }}
      >
        <span>{display || placeholder}</span>
        <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          {value && !disabled && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onChange(null); } }}
              style={{ color: 'var(--muted)', fontSize: '0.8rem', lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}
              aria-label="Clear date"
            >
              ×
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--muted-soft)' }}>
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </span>
      </button>

      {open && popupPos && (
        <div style={{
          position: 'fixed', top: popupPos.top, left: popupPos.left, zIndex: 9999,
          background: 'var(--surface-1)', border: '1px solid var(--line)',
          borderRadius: 10, boxShadow: 'var(--shadow-md)', minWidth: Math.max(220, popupPos.width),
        }}>
          {mode === 'month' ? (
            <MonthYearPanel
              year={year}
              month={parsed?.getUTCMonth() ?? -1}
              onSelect={handleMonthSelect}
              onYearChange={(delta) => setYear((y) => y + delta)}
            />
          ) : (
            <DatePanel
              year={year}
              month={month}
              selectedDate={parsed}
              onSelect={handleDateSelect}
              onNavMonth={handleNavMonth}
            />
          )}
        </div>
      )}
    </div>
  );
}
