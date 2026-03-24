'use client';

import { useState, useCallback } from 'react';

export interface ContextMenuState<T> {
  x: number;
  y: number;
  data: T;
}

export function useContextMenu<T>() {
  const [menu, setMenu] = useState<ContextMenuState<T> | null>(null);

  const open = useCallback((e: React.MouseEvent, data: T) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, data });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, close };
}
