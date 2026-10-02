'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type MenuItem = { type: 'item'; label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string };

export type MenuEntry =
  | MenuItem
  | { type: 'separator' }
  /** Non-interactive section label (e.g. "3 selected"). */
  | { type: 'header'; label: string }
  /** Opens a flyout of items on hover/click. */
  | { type: 'submenu'; label: string; icon?: React.ReactNode; items: MenuEntry[]; disabled?: boolean };

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

/** Clamp a fixed-position panel so it stays on screen. */
function useClampedPosition(ref: React.RefObject<HTMLDivElement | null>, x: number, y: number, flipFrom?: number, pinBottom = false) {
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Flyouts that would run off the right edge open to the left of their parent.
    const left = x + width > vw
      ? (flipFrom !== undefined ? Math.max(0, flipFrom - width) : Math.max(0, vw - width - 8))
      : x;
    // Root menus that would run off the bottom open UPWARD from the anchor (OS
    // behaviour; also lets a bottom toolbar anchor a menu above itself).
    // Flyouts just slide up to fit.
    const top = y + height > vh
      ? (pinBottom ? Math.max(0, vh - height - 8) : Math.max(8, y - height))
      : y;
    setPos({ left, top });
  }, [ref, x, y, flipFrom, pinBottom]);
  return pos;
}

function MenuPanel({ entries, onClose, openSub, setOpenSub, panelRef, style }: {
  entries: MenuEntry[];
  onClose: () => void;
  openSub: { index: number; rect: DOMRect } | null;
  setOpenSub: (s: { index: number; rect: DOMRect } | null) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
}) {
  return (
    <div ref={panelRef} className="ctx-menu" style={style} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((entry, i) => {
        if (entry.type === 'separator') return <div key={i} className="ctx-separator" />;
        if (entry.type === 'header') return <div key={i} className="ctx-header">{entry.label}</div>;
        if (entry.type === 'submenu') {
          const open = openSub?.index === i;
          const show = (el: HTMLElement) => { if (!entry.disabled) setOpenSub({ index: i, rect: el.getBoundingClientRect() }); };
          return (
            <button
              key={i}
              type="button"
              className={`ctx-item ctx-item--submenu${open ? ' ctx-item--open' : ''}`}
              disabled={entry.disabled}
              aria-haspopup="menu"
              aria-expanded={open}
              onMouseEnter={(e) => show(e.currentTarget)}
              onClick={(e) => show(e.currentTarget)}
            >
              {entry.icon && <span className="ctx-item-icon">{entry.icon}</span>}
              <span>{entry.label}</span>
              <svg className="ctx-item-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          );
        }
        return (
          <button
            key={i}
            type="button"
            className={`ctx-item${entry.danger ? ' ctx-item--danger' : ''}`}
            disabled={entry.disabled}
            title={entry.title}
            onMouseEnter={() => setOpenSub(null)}
            onClick={() => { entry.onClick(); onClose(); }}
          >
            {entry.icon && <span className="ctx-item-icon">{entry.icon}</span>}
            <span>{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Flyout({ entries, anchor, onClose, flyRef }: {
  entries: MenuEntry[]; anchor: DOMRect; onClose: () => void; flyRef: React.RefObject<HTMLDivElement | null>;
}) {
  const pos = useClampedPosition(flyRef, anchor.right + 2, anchor.top - 5, anchor.left - 2, true);
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  return (
    <MenuPanel
      entries={entries}
      onClose={onClose}
      openSub={openSub}
      setOpenSub={setOpenSub}
      panelRef={flyRef}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1001 }}
    />
  );
}

export function ContextMenu({ x, y, items, onClose }: Readonly<Props>) {
  const ref = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const pos = useClampedPosition(ref, x, y);
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect } | null>(null);

  // Close on outside click or Escape (the flyout counts as inside).
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || flyRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const sub = openSub ? items[openSub.index] : null;

  return createPortal(
    <>
      <MenuPanel
        entries={items}
        onClose={onClose}
        openSub={openSub}
        setOpenSub={setOpenSub}
        panelRef={ref}
        style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1000 }}
      />
      {openSub && sub?.type === 'submenu' && (
        <Flyout key={openSub.index} entries={sub.items} anchor={openSub.rect} onClose={onClose} flyRef={flyRef} />
      )}
    </>,
    document.body
  );
}
