'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TaskTypeStatus } from '@/lib/models/task-phase';

/**
 * Pre-Production board column config, shared across the dashboard's task
 * surfaces (TaskBoard, TaskDetailModal, NewTaskModal) so they all see the same
 * live list without prop-drilling. Initial values are seeded server-side from
 * /dashboard's page.tsx (which queries task_phase_configs directly); the
 * column editor calls refresh() after every mutation so the rest of the UI
 * stays in sync without a full reload.
 */

export interface PreprodConfigContextValue {
  statuses: TaskTypeStatus[];
  /** True for admins + users in preprod_board_admins. Drives whether the
   *  "Manage columns" button is rendered. */
  canEditColumns: boolean;
  /** Re-fetch the column list from /api/preprod-board/columns. The editor
   *  calls this after every create / rename / recolor / delete / reorder so
   *  the kanban reflects the change immediately. */
  refresh: () => Promise<void>;
}

const PreprodConfigContext = createContext<PreprodConfigContextValue>({
  statuses: [],
  canEditColumns: false,
  refresh: async () => {},
});

interface PreprodConfigProviderProps {
  initialStatuses: TaskTypeStatus[];
  canEditColumns: boolean;
  children: ReactNode;
}

export function PreprodConfigProvider({
  initialStatuses,
  canEditColumns,
  children,
}: PreprodConfigProviderProps) {
  const [statuses, setStatuses] = useState<TaskTypeStatus[]>(initialStatuses);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/preprod-board/columns');
      if (!res.ok) return;
      const data = (await res.json()) as {
        columns?: Array<{ slug: string; label: string; color: string }>;
      };
      const next = (data.columns ?? []).map((c) => ({
        value: c.slug,
        label: c.label,
        color: c.color,
      }));
      setStatuses(next);
    } catch {
      /* swallow — next interaction will retry */
    }
  }, []);

  const value = useMemo<PreprodConfigContextValue>(
    () => ({ statuses, canEditColumns, refresh }),
    [statuses, canEditColumns, refresh],
  );

  return <PreprodConfigContext.Provider value={value}>{children}</PreprodConfigContext.Provider>;
}

export function usePreprodConfig(): PreprodConfigContextValue {
  return useContext(PreprodConfigContext);
}
