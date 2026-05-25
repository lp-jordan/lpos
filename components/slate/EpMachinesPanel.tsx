'use client';

import { useState, useEffect, useCallback } from 'react';
import type { EpInstanceWithStatus } from '@/lib/store/ep-instances';

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function EpMachinesPanel() {
  const [instances, setInstances] = useState<EpInstanceWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  const fetchInstances = useCallback(async () => {
    try {
      const res = await fetch('/api/ep/instances');
      if (res.ok) {
        const data = await res.json() as { instances: EpInstanceWithStatus[] };
        setInstances(data.instances ?? []);
      }
    } catch {
      // silently ignore — network errors shouldn't break the panel
    } finally {
      setLoading(false);
      setLastRefresh(Date.now());
    }
  }, []);

  useEffect(() => {
    fetchInstances();
    const timer = setInterval(fetchInstances, 5000);
    return () => clearInterval(timer);
  }, [fetchInstances]);

  return (
    <div className="ep-machines-panel">
      <div className="ep-machines-header">
        <span className="ep-machines-title">EditPanel Instances</span>
        <button
          type="button"
          className="ep-machines-refresh"
          onClick={fetchInstances}
          title="Refresh"
        >
          <RefreshIcon />
        </button>
      </div>

      {loading ? (
        <div className="ep-machines-empty">Loading…</div>
      ) : instances.length === 0 ? (
        <div className="ep-machines-empty">
          <MonitorIcon />
          <span>No EditPanel instances have connected yet.</span>
          <span className="ep-machines-hint">Instances appear here once they send their first heartbeat.</span>
        </div>
      ) : (
        <div className="ep-machines-grid">
          {instances.map((inst) => (
            <div key={inst.instanceId} className={`ep-machine-card${inst.online ? '' : ' ep-machine-card--offline'}`}>
              <div className="ep-machine-top">
                <span className={`ep-machine-dot${inst.online ? ' ep-machine-dot--online' : ''}`} />
                <span className="ep-machine-name">{inst.displayName}</span>
                <span className="ep-machine-since">{timeAgo(inst.lastSeen)}</span>
              </div>

              <div className="ep-machine-resolve">
                {inst.resolveConnected ? (
                  <>
                    <span className="ep-machine-resolve-badge ep-machine-resolve-badge--ok">Resolve Connected</span>
                    {inst.resolveProject && (
                      <span className="ep-machine-resolve-detail">{inst.resolveProject}</span>
                    )}
                    {inst.resolveTimeline && (
                      <span className="ep-machine-resolve-detail ep-machine-resolve-detail--dim">{inst.resolveTimeline}</span>
                    )}
                  </>
                ) : (
                  <span className="ep-machine-resolve-badge ep-machine-resolve-badge--off">Resolve Offline</span>
                )}
              </div>

              {(inst.jobsQueued > 0 || inst.jobsRunning > 0) && (
                <div className="ep-machine-jobs">
                  {inst.jobsRunning > 0 && (
                    <span className="ep-machine-job-chip ep-machine-job-chip--running">
                      {inst.jobsRunning} running
                    </span>
                  )}
                  {inst.jobsQueued > 0 && (
                    <span className="ep-machine-job-chip">
                      {inst.jobsQueued} queued
                    </span>
                  )}
                </div>
              )}

              <div className="ep-machine-id">{inst.instanceId}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
