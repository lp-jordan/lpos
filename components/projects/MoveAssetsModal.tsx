'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/lib/models/project';

/**
 * Bulk-move modal — picks a target project for one or more selected assets
 * and POSTs to /api/projects/<from>/media/move. Surfaces the Frame.io history-
 * split warning before the move executes (Frame.io references aren't moved on
 * the FIO side — spec'd as LPOS-only).
 */

interface Props {
  fromProjectId: string;
  fromProjectName: string;
  selectedCount: number;
  selectedAssetIds: string[];
  onClose: () => void;
  /** Fired after a successful move so the caller can refresh state. The list
   *  is the asset ids that actually moved; failed ids stay in the source. */
  onMoved: (movedIds: string[]) => void;
}

export function MoveAssetsModal({
  fromProjectId,
  fromProjectName,
  selectedCount,
  selectedAssetIds,
  onClose,
  onMoved,
}: Readonly<Props>) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/projects');
        if (!res.ok) throw new Error('Failed to load projects');
        const data = (await res.json()) as { projects?: Project[] };
        if (cancelled) return;
        // Exclude the source project + archived projects from the picker.
        const list = (data.projects ?? []).filter(
          (p) => p.projectId !== fromProjectId && !p.archived,
        );
        setProjects(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fromProjectId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.clientName ?? '').toLowerCase().includes(q),
    );
  }, [projects, search]);

  // Group projects by clientName so the picker reads as a familiar tree.
  const grouped = useMemo(() => {
    const buckets = new Map<string, Project[]>();
    for (const p of filtered) {
      const k = p.clientName ?? 'Other';
      const arr = buckets.get(k) ?? [];
      arr.push(p);
      buckets.set(k, arr);
    }
    return Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const targetProject = projects.find((p) => p.projectId === targetId) ?? null;

  async function handleConfirm() {
    if (!targetId) return;
    setMoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${fromProjectId}/media/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: selectedAssetIds, targetProjectId: targetId }),
      });
      const data = (await res.json()) as {
        moved?: string[];
        failed?: Array<{ assetId: string; reason: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? 'Move failed');
      const moved = data.moved ?? [];
      if (moved.length === 0) {
        setError(`No assets were moved. ${data.failed?.[0]?.reason ?? 'See server logs.'}`);
        return;
      }
      if (data.failed && data.failed.length > 0) {
        // Partial success — surface what happened, but still call onMoved
        // so the UI refreshes for the ones that succeeded.
        setError(
          `Moved ${moved.length} of ${moved.length + data.failed.length}. ` +
          `${data.failed.length} failed — first error: ${data.failed[0].reason}`,
        );
      }
      onMoved(moved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            Move {selectedCount} asset{selectedCount === 1 ? '' : 's'} to another project
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: '0.85rem', margin: 0, opacity: 0.8 }}>
            From <strong>{fromProjectName}</strong> → choose a target project below.
          </p>

          <input
            type="text"
            placeholder="Search by project or client name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{
              padding: '8px 12px', borderRadius: 6,
              border: '1px solid var(--color-border, #333)',
              background: 'var(--color-input-bg, #1a1a1a)', color: 'inherit',
              fontSize: '0.875rem',
            }}
          />

          {loading && <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>Loading projects…</p>}

          {!loading && (
            <div
              style={{
                maxHeight: 320, overflowY: 'auto',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              {grouped.length === 0 && (
                <p style={{ padding: 12, fontSize: '0.85rem', opacity: 0.6, margin: 0 }}>
                  No eligible projects found.
                </p>
              )}
              {grouped.map(([clientName, list]) => (
                <div key={clientName}>
                  <div
                    style={{
                      padding: '6px 12px', fontSize: '0.72rem',
                      letterSpacing: '0.05em', textTransform: 'uppercase',
                      opacity: 0.5, background: 'rgba(255,255,255,0.03)',
                    }}
                  >
                    {clientName}
                  </div>
                  {list.map((p) => (
                    <label
                      key={p.projectId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px', cursor: 'pointer',
                        background: targetId === p.projectId ? 'rgba(201,162,39,0.10)' : 'transparent',
                      }}
                    >
                      <input
                        type="radio"
                        name="target-project"
                        value={p.projectId}
                        checked={targetId === p.projectId}
                        onChange={() => setTargetId(p.projectId)}
                      />
                      <span style={{ fontSize: '0.875rem' }}>{p.name}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Warning — surfaced before confirm so editors aren't surprised. */}
          <div
            style={{
              padding: '8px 12px', borderRadius: 4,
              background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
              color: '#f59e0b', fontSize: '0.78rem',
            }}
          >
            Heads-up: the move is LPOS-side only. The Frame.io asset stays in {fromProjectName}'s
            Frame.io project — review links / comment history won't follow. You can re-upload to
            Frame.io from the target project if needed.
          </div>

          {error && (
            <p style={{ color: '#e07070', fontSize: '0.85rem', margin: 0 }}>{error}</p>
          )}

          <div className="modal-actions">
            <button type="button" className="modal-btn-ghost" onClick={onClose} disabled={moving}>
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn-primary"
              onClick={() => void handleConfirm()}
              disabled={!targetId || moving}
            >
              {moving
                ? 'Moving…'
                : targetProject
                  ? `Move to ${targetProject.name}`
                  : 'Move'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
