'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/lib/models/project';

/**
 * Bulk-move modal — picks a target project for one or more selected assets and
 * POSTs to /api/projects/<from>/media/move. Surfaces the Frame.io history-split
 * warning before the move executes (Frame.io references aren't moved on the FIO
 * side — spec'd as LPOS-only).
 *
 * Name collisions: before committing, the modal runs a preflight
 * (/media/move/preflight). If the target already has an asset with the same
 * name, it shows a resolution step so the editor decides per asset whether the
 * moved file is a NEW VERSION of the existing one (merge/stack), a KEEP-BOTH
 * (rename with a " (n)" suffix), or a SKIP (leave it in the source — the default
 * for exact-content duplicates). Only after every collision is resolved does the
 * actual move fire.
 */

type ResolutionAction = 'rename' | 'new_version' | 'skip';

interface Collision {
  movingAssetId: string;
  movingName: string;
  destAssetId: string;
  destName: string;
  destMaxVersionNumber: number;
  isExactDuplicate: boolean;
}

interface MoveResponse {
  moved?: string[];
  renamed?: Array<{ assetId: string; newName: string }>;
  merged?: Array<{ assetId: string; destAssetId: string; asVersion: number }>;
  skipped?: Array<{ assetId: string; reason: string }>;
  failed?: Array<{ assetId: string; reason: string }>;
  error?: string;
}

interface Props {
  fromProjectId: string;
  fromProjectName: string;
  selectedCount: number;
  selectedAssetIds: string[];
  onClose: () => void;
  /** Fired after a move so the caller can refresh state. The list is the asset
   *  ids that left the source project (plain moves + renames + merges); skipped
   *  ids stay put. */
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

  // 'pick' → choose target; 'resolve' → resolve name collisions; 'summary' →
  // show the outcome when something was skipped or failed.
  const [phase, setPhase] = useState<'pick' | 'resolve' | 'summary'>('pick');
  const [collisions, setCollisions] = useState<Collision[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, ResolutionAction>>({});
  const [moveResult, setMoveResult] = useState<MoveResponse | null>(null);

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

  /** Commit the move (optionally with collision resolutions). Auto-closes via
   *  onMoved when the outcome is clean; otherwise parks on the summary step. */
  async function doMove(res: Record<string, ResolutionAction>) {
    setMoving(true);
    setError(null);
    try {
      const resp = await fetch(`/api/projects/${fromProjectId}/media/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds: selectedAssetIds,
          targetProjectId: targetId,
          resolutions: res,
        }),
      });
      const data = (await resp.json()) as MoveResponse;
      if (!resp.ok) throw new Error(data.error ?? 'Move failed');

      const moved = data.moved ?? [];
      const merged = data.merged ?? [];
      const skipped = data.skipped ?? [];
      const failed = data.failed ?? [];
      // Assets that left the source: plain/renamed moves + merges.
      const leftSource = [...moved, ...merged.map((m) => m.assetId)];

      if (leftSource.length === 0 && skipped.length === 0) {
        setError(`No assets were moved. ${failed[0]?.reason ?? 'See server logs.'}`);
        return;
      }

      // Clean outcome (nothing skipped or failed) → refresh + close immediately.
      if (skipped.length === 0 && failed.length === 0) {
        onMoved(leftSource);
        return;
      }

      // Otherwise show the outcome so the editor sees what was skipped/failed.
      setMoveResult(data);
      setPhase('summary');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  /** Step 1 → run preflight; branch to resolution or move directly. */
  async function handleConfirmTarget() {
    if (!targetId) return;
    setMoving(true);
    setError(null);
    try {
      const resp = await fetch(`/api/projects/${fromProjectId}/media/move/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: selectedAssetIds, targetProjectId: targetId }),
      });
      const data = (await resp.json()) as { collisions?: Collision[]; error?: string };
      if (!resp.ok) throw new Error(data.error ?? 'Preflight failed');
      const found = data.collisions ?? [];
      if (found.length === 0) {
        await doMove({});
        return;
      }
      // Seed defaults: exact duplicates default to Skip (identical file already
      // there); everything else defaults to Keep-both (the non-destructive choice).
      const defaults: Record<string, ResolutionAction> = {};
      for (const c of found) defaults[c.movingAssetId] = c.isExactDuplicate ? 'skip' : 'rename';
      setCollisions(found);
      setResolutions(defaults);
      setPhase('resolve');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  const nonCollidingCount = selectedAssetIds.length - collisions.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {phase === 'pick' && `Move ${selectedCount} asset${selectedCount === 1 ? '' : 's'} to another project`}
            {phase === 'resolve' && `Resolve name conflict${collisions.length === 1 ? '' : 's'}`}
            {phase === 'summary' && 'Move complete'}
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ---------- Step 1: pick target ---------- */}
        {phase === 'pick' && (
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
                onClick={() => void handleConfirmTarget()}
                disabled={!targetId || moving}
              >
                {moving
                  ? 'Checking…'
                  : targetProject
                    ? `Move to ${targetProject.name}`
                    : 'Move'}
              </button>
            </div>
          </div>
        )}

        {/* ---------- Step 2: resolve collisions ---------- */}
        {phase === 'resolve' && (
          <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: '0.85rem', margin: 0, opacity: 0.8 }}>
              {collisions.length === 1 ? 'This asset' : `${collisions.length} of these assets`} already
              exist by name in <strong>{targetProject?.name}</strong>. Choose what to do with each.
              {nonCollidingCount > 0 && (
                <> The other {nonCollidingCount} will move normally.</>
              )}
            </p>

            <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {collisions.map((c) => (
                <div
                  key={c.movingAssetId}
                  style={{
                    border: '1px solid rgba(255,255,255,0.10)', borderRadius: 6,
                    padding: '10px 12px', background: 'rgba(255,255,255,0.02)',
                  }}
                >
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 2 }}>
                    {c.movingName}
                  </div>
                  {c.isExactDuplicate && (
                    <div style={{ fontSize: '0.74rem', color: '#f59e0b', marginBottom: 6 }}>
                      Exact duplicate — an identical file already exists in {targetProject?.name}.
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {([
                      { action: 'new_version' as const, label: `New version of "${c.destName}" (v${c.destMaxVersionNumber + 1})` },
                      { action: 'rename' as const, label: 'Keep both — rename the moved copy' },
                      { action: 'skip' as const, label: `Skip — leave it in ${fromProjectName}` },
                    ]).map((opt) => (
                      <label
                        key={opt.action}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.82rem' }}
                      >
                        <input
                          type="radio"
                          name={`res-${c.movingAssetId}`}
                          checked={resolutions[c.movingAssetId] === opt.action}
                          onChange={() =>
                            setResolutions((prev) => ({ ...prev, [c.movingAssetId]: opt.action }))
                          }
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <p style={{ color: '#e07070', fontSize: '0.85rem', margin: 0 }}>{error}</p>
            )}

            <div className="modal-actions">
              <button type="button" className="modal-btn-ghost" onClick={() => setPhase('pick')} disabled={moving}>
                Back
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                onClick={() => void doMove(resolutions)}
                disabled={moving}
              >
                {moving ? 'Moving…' : `Move ${selectedCount} asset${selectedCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}

        {/* ---------- Step 3: summary (only when something was skipped/failed) ---------- */}
        {phase === 'summary' && moveResult && (
          <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(moveResult.moved?.length ?? 0) > 0 && (
                <li>Moved {moveResult.moved!.length} asset{moveResult.moved!.length === 1 ? '' : 's'}
                  {(moveResult.renamed?.length ?? 0) > 0 && ` (${moveResult.renamed!.length} renamed to avoid a clash)`}.</li>
              )}
              {(moveResult.merged?.length ?? 0) > 0 && (
                <li>Merged {moveResult.merged!.length} as new version{moveResult.merged!.length === 1 ? '' : 's'} of existing assets.</li>
              )}
              {(moveResult.skipped?.length ?? 0) > 0 && (
                <li style={{ color: '#f59e0b' }}>
                  Skipped {moveResult.skipped!.length}
                  {moveResult.skipped!.some((s) => s.reason === 'exact-duplicate')
                    ? ' (exact duplicate already in target)'
                    : ''} — left in {fromProjectName}.
                </li>
              )}
              {(moveResult.failed?.length ?? 0) > 0 && (
                <li style={{ color: '#e07070' }}>
                  Failed {moveResult.failed!.length} — first: {moveResult.failed![0].reason}.
                </li>
              )}
            </ul>

            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-primary"
                onClick={() => {
                  const leftSource = [
                    ...(moveResult.moved ?? []),
                    ...(moveResult.merged ?? []).map((m) => m.assetId),
                  ];
                  onMoved(leftSource);
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
