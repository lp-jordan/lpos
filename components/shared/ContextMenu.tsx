'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type MenuEntry =
  | { type: 'item'; label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { type: 'separator' };

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Readonly<Props>) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp to viewport after mount
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: x + width > vw ? Math.max(0, vw - width - 8) : x,
      top:  y + height > vh ? Math.max(0, vh - height - 8) : y,
    });
  }, [x, y]);

  // Close on outside click or Escape
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1000 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if (entry.type === 'separator') {
          return <div key={i} className="ctx-separator" />;
        }
        return (
          <button
            key={i}
            type="button"
            className={`ctx-item${entry.danger ? ' ctx-item--danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => { entry.onClick(); onClose(); }}
          >
            {entry.icon && <span className="ctx-item-icon">{entry.icon}</span>}
            <span>{entry.label}</span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}
