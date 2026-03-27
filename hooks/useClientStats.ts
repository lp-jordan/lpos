'use client';

import { useEffect, useState } from 'react';

export interface ClientStats {
  mediaCount: number;
  scriptCount: number;
}

export function useClientStats(): Record<string, ClientStats> {
  const [stats, setStats] = useState<Record<string, ClientStats>>({});

  useEffect(() => {
    fetch('/api/client-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { stats: Record<string, ClientStats> } | null) => {
        if (d?.stats) setStats(d.stats);
      })
      .catch(() => {});
  }, []);

  return stats;
}
