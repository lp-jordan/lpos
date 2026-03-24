'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
} from 'react';
import { ContextMenu, type MenuEntry } from '@/components/shared/ContextMenu';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

interface ContextMenuContextValue {
  openMenu: (x: number, y: number, items: MenuEntry[]) => void;
  closeMenu: () => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const ContextMenuContext = createContext<ContextMenuContextValue>({
  openMenu: () => {},
  closeMenu: () => {},
});

// ── Provider ──────────────────────────────────────────────────────────────────

export function ContextMenuProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const openMenu = useCallback((x: number, y: number, items: MenuEntry[]) => {
    setMenu({ x, y, items });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <ContextMenuContext.Provider value={{ openMenu, closeMenu }}>
      {children}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={closeMenu}
        />
      )}
    </ContextMenuContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useContextMenu() {
  return useContext(ContextMenuContext);
}
