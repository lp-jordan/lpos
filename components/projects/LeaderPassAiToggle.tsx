'use client';

import { useCallback, useEffect, useState } from 'react';

interface Props {
  projectId: string;
}

interface ReprovisionSummary {
  pushed: number;
  failed: number;
  skipped: number;
}

/**
 * Per-project "Use in LeaderPass AI" control. Lives in the project header.
 *
 *  - Reads/writes the toggle via /api/projects/:id/lpai (GET/PUT).
 *  - Toggle-ON kicks off provisioning of all current videos server-side.
 *  - "Re-provision" manually re-pushes every eligible video and shows a summary.
 *
 * When LP.AI is not configured on the host the control still renders but is
 * disabled with an explanatory note, so operators can see the feature exists.
 */
export function LeaderPassAiToggle({ projectId }: Readonly<Props>) {
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reprovisioning, setReprovisioning] = useState(false);
  const [summary, setSummary] = useState<ReprovisionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/lpai`);
        if (!res.ok) return;
        const data = await res.json() as { enabled: boolean; configured: boolean };
        if (cancelled) return;
        setEnabled(data.enabled);
        setConfigured(data.configured);
      } catch {
        // Ignore load errors — leave defaults.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const toggle = useCallback(async () => {
    if (saving) return;
    const next = !enabled;
    setSaving(true);
    setError(null);
    setSummary(null);
    // Optimistic.
    setEnabled(next);
    try {
      const res = await fetch(`/api/projects/${projectId}/lpai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? 'Failed to update');
      }
      const data = await res.json() as { enabled: boolean; configured: boolean };
      setEnabled(data.enabled);
      setConfigured(data.configured);
    } catch (err) {
      setEnabled(!next); // revert
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [enabled, projectId, saving]);

  const reprovision = useCallback(async () => {
    if (reprovisioning) return;
    setReprovisioning(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/lpai/reprovision`, { method: 'POST' });
      const data = await res.json().catch(() => ({})) as { error?: string; pushed?: number; failed?: number; skipped?: number };
      if (!res.ok) throw new Error(data.error ?? 'Re-provision failed');
      setSummary({ pushed: data.pushed ?? 0, failed: data.failed ?? 0, skipped: data.skipped ?? 0 });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReprovisioning(false);
    }
  }, [projectId, reprovisioning]);

  if (loading) return null;

  return (
    <div className="lpai-toggle" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.8rem',
            color: 'var(--color-text-muted, #9aa0a6)',
            cursor: configured ? 'pointer' : 'not-allowed',
            opacity: configured ? 1 : 0.6,
          }}
          title={configured
            ? 'Push this project’s videos to LeaderPass AI for search & Q&A'
            : 'LeaderPass AI is not configured on this host (set LPAI_BASE_URL / LPAI_INGEST_SECRET)'}
        >
          <input
            type="checkbox"
            checked={enabled}
            disabled={!configured || saving}
            onChange={() => void toggle()}
          />
          <span>Use in LeaderPass&nbsp;AI</span>
        </label>
        {enabled && configured && (
          <button
            type="button"
            className="proj-secondary-btn"
            onClick={() => void reprovision()}
            disabled={reprovisioning}
            style={{ fontSize: '0.72rem', padding: '0.2rem 0.55rem' }}
          >
            {reprovisioning ? 'Re-provisioning…' : 'Re-provision'}
          </button>
        )}
      </div>
      {summary && (
        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted, #9aa0a6)' }}>
          Pushed {summary.pushed}
          {summary.skipped > 0 ? ` · skipped ${summary.skipped}` : ''}
          {summary.failed > 0 ? ` · failed ${summary.failed}` : ''}
        </span>
      )}
      {error && (
        <span style={{ fontSize: '0.72rem', color: 'var(--color-danger, #ff6b6b)' }}>{error}</span>
      )}
    </div>
  );
}
