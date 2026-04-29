'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AmaranStatus } from '@/lib/services/amaran-service';
import type { AmaranConfig } from '@/lib/store/studio-config-store';
import type { AmaranFixtureGroup } from '@/lib/lighting-constants';
import { AMARAN_GROUPS } from '@/lib/lighting-constants';

export type { AmaranFixtureGroup };

export interface FixtureArrangement {
  fixtureLabels: Record<string, string>;
  fixtureGroups: Record<string, AmaranFixtureGroup>;
  fixtureOrder:  Record<AmaranFixtureGroup, string[]>;
}

const DEFAULT_ARRANGEMENT: FixtureArrangement = {
  fixtureLabels: {},
  fixtureGroups: {},
  fixtureOrder:  { bookshelves: [], void: [], mobile: [] },
};

export function useLighting() {
  const socketRef   = useRef<Socket | null>(null);
  const [status,      setStatus]      = useState<AmaranStatus | null>(null);
  const [arrangement, setArrangement] = useState<FixtureArrangement>(DEFAULT_ARRANGEMENT);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/studio/lighting')
      .then((r) => r.json())
      .then((d: { status?: AmaranStatus }) => { if (d.status) setStatus(d.status); })
      .catch(() => {});

    fetch('/api/studio/lighting/config')
      .then((r) => r.json())
      .then((d: { config?: AmaranConfig }) => {
        if (!d.config) return;
        setArrangement({
          fixtureLabels: d.config.fixtureLabels ?? {},
          fixtureGroups: d.config.fixtureGroups ?? {},
          fixtureOrder:  d.config.fixtureOrder  ?? { bookshelves: [], void: [], mobile: [] },
        });
      })
      .catch(() => {});

    const socket = io('/', { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('amaran:status', (s: AmaranStatus) => setStatus(s));

    return () => { socket.disconnect(); };
  }, []);

  // ── Command ──────────────────────────────────────────────────────────────────

  const sendCommand = useCallback(async (
    method: string,
    nodeId: string,
    params: Record<string, unknown> = {},
  ) => {
    setError(null);
    setLoading(true);
    try {
      const res  = await fetch('/api/studio/lighting', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ method, nodeId, params }),
      });
      const data = await res.json() as { ok?: boolean; status?: AmaranStatus; error?: string };
      if (!res.ok) { setError(data.error ?? 'Command failed'); return; }
      if (data.status) setStatus(data.status);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Connection ───────────────────────────────────────────────────────────────

  const connect = useCallback(async (port: number) => {
    setError(null);
    try {
      await fetch('/api/studio/lighting/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await fetch('/api/studio/lighting/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      const res  = await fetch('/api/studio/lighting');
      const data = await res.json() as { status?: AmaranStatus };
      if (data.status) setStatus(data.status);
    } catch {
      setError('Could not connect');
    }
  }, []);

  const disconnect = useCallback(async () => {
    await fetch('/api/studio/lighting/connect', { method: 'DELETE' });
    const res  = await fetch('/api/studio/lighting');
    const data = await res.json() as { status?: AmaranStatus };
    if (data.status) setStatus(data.status);
  }, []);

  const rediscover = useCallback(async () => {
    setError(null);
    try {
      const res  = await fetch('/api/studio/lighting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'rediscover' }),
      });
      const data = await res.json() as { status?: AmaranStatus; error?: string };
      if (!res.ok) { setError(data.error ?? 'Refresh failed'); return; }
      if (data.status) setStatus(data.status);
    } catch {
      setError('Network error');
    }
  }, []);

  // ── Arrangement mutations ────────────────────────────────────────────────────

  const patchConfig = useCallback(async (patch: Partial<AmaranConfig>) => {
    try {
      await fetch('/api/studio/lighting/config', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* non-critical */ }
  }, []);

  const renameFixture = useCallback(async (nodeId: string, label: string) => {
    setArrangement((prev) => ({ ...prev, fixtureLabels: { ...prev.fixtureLabels, [nodeId]: label } }));
    await patchConfig({ fixtureLabels: { [nodeId]: label } });
  }, [patchConfig]);

  /** Move a fixture to a different section (admin only). */
  const moveFixtureToGroup = useCallback(async (nodeId: string, group: AmaranFixtureGroup) => {
    setArrangement((prev) => {
      // Remove from all group order arrays, then append to target
      const newOrder = { ...prev.fixtureOrder };
      for (const g of AMARAN_GROUPS) {
        newOrder[g] = newOrder[g].filter((id) => id !== nodeId);
      }
      newOrder[group] = [...newOrder[group], nodeId];
      return { ...prev, fixtureGroups: { ...prev.fixtureGroups, [nodeId]: group }, fixtureOrder: newOrder };
    });
    // Persist — we patch both fields; the API merges them
    setArrangement((prev) => {
      void patchConfig({ fixtureGroups: { [nodeId]: group }, fixtureOrder: prev.fixtureOrder });
      return prev;
    });
  }, [patchConfig]);

  /** Reorder fixtures within a section. newOrder is the full ordered nodeId array for that group. */
  const reorderGroup = useCallback(async (group: AmaranFixtureGroup, newOrder: string[]) => {
    setArrangement((prev) => ({
      ...prev,
      fixtureOrder: { ...prev.fixtureOrder, [group]: newOrder },
    }));
    await patchConfig({ fixtureOrder: { [group]: newOrder } as Record<AmaranFixtureGroup, string[]> });
  }, [patchConfig]);

  /** Pull the current Amaran status from the server and sync React state. */
  const syncStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/studio/lighting');
      const data = await res.json() as { status?: AmaranStatus };
      if (data.status) setStatus(data.status);
    } catch { /* non-critical */ }
  }, []);

  return {
    status,
    loading,
    error,
    arrangement,
    sendCommand,
    syncStatus,
    connect,
    disconnect,
    rediscover,
    renameFixture,
    moveFixtureToGroup,
    reorderGroup,
  };
}
