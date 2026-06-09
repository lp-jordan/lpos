'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePreprodConfig } from '@/components/dashboard/preprod-config-context';

/**
 * Pre-Production board column editor.
 *
 * Surfaces add / rename / recolor / reorder / delete for a single task_type
 * ('preprod' in v1). Visible only when the calling user has permission
 * (admin role OR membership in preprod_board_admins) — TaskBoard gates that
 * via canEditColumns from PreprodConfigContext.
 *
 * Reorder is up/down buttons in v1; explicit drag-and-drop would mean
 * pulling @dnd-kit/sortable into a new surface, which isn't worth it for an
 * occasional-use editor.
 */

interface ColumnRow {
  configId: string;
  slug: string;
  label: string;
  color: string;
  sortOrder: number;
}

/** Hand-picked palette — matches the colors used in TASK_TYPE_CONFIGS so the
 *  preprod board reads as visually consistent with Editing / Platform. */
const COLOR_PALETTE = [
  '#e05c6a', '#f59e0b', '#c9a227', '#10b981', '#34d399',
  '#0ea5e9', '#3b82f6', '#7c3aed', '#ec4899', '#94a3b8',
  '#6b7280', '#5a6478', '#f97316',
] as const;

function pickNextColor(used: string[]): string {
  for (const c of COLOR_PALETTE) {
    if (!used.includes(c)) return c;
  }
  return COLOR_PALETTE[used.length % COLOR_PALETTE.length];
}

interface Props {
  onClose: () => void;
}

export function PreprodColumnEditorModal({ onClose }: Readonly<Props>) {
  const { refresh } = usePreprodConfig();
  const [rows, setRows] = useState<ColumnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  // New-column draft state
  const [draftLabel, setDraftLabel] = useState('');
  const [draftColor, setDraftColor] = useState<string>(COLOR_PALETTE[0]);
  const [adding, setAdding] = useState(false);

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  // Delete-confirm state (shows task-count warning if non-zero)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/preprod-board/columns');
      if (!res.ok) throw new Error('Failed to load columns');
      const data = (await res.json()) as {
        columns: Array<{ configId: string; slug: string; label: string; color: string; sortOrder: number }>;
      };
      setRows(data.columns);
      setDraftColor(pickNextColor(data.columns.map((c) => c.color)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 140);
  }

  // Close on Escape — but only when no inline editor / draft input is focused,
  // otherwise users typing a column name would close the modal mid-edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      handleClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAdd() {
    if (!draftLabel.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/preprod-board/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: draftLabel.trim(), color: draftColor }),
      });
      const data = (await res.json()) as { columns?: ColumnRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add column');
      setRows(data.columns ?? []);
      setDraftLabel('');
      setDraftColor(pickNextColor((data.columns ?? []).map((c) => c.color)));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  function startRename(row: ColumnRow) {
    setEditingId(row.configId);
    setEditingLabel(row.label);
  }

  async function commitRename(configId: string) {
    const trimmed = editingLabel.trim();
    const original = rows.find((r) => r.configId === configId);
    setEditingId(null);
    if (!original || !trimmed || trimmed === original.label) return;
    setBusyId(configId);
    setError(null);
    try {
      const res = await fetch(`/api/preprod-board/columns/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      });
      const data = (await res.json()) as { columns?: ColumnRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to rename column');
      setRows(data.columns ?? []);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function changeColor(configId: string, color: string) {
    setBusyId(configId);
    setError(null);
    try {
      const res = await fetch(`/api/preprod-board/columns/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color }),
      });
      const data = (await res.json()) as { columns?: ColumnRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to update color');
      setRows(data.columns ?? []);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function moveRow(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = rows.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next); // optimistic
    setError(null);
    try {
      const res = await fetch('/api/preprod-board/columns/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configIds: next.map((r) => r.configId) }),
      });
      const data = (await res.json()) as { columns?: ColumnRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to reorder columns');
      setRows(data.columns ?? []);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      void load(); // resync on failure
    }
  }

  async function handleDelete(configId: string) {
    setBusyId(configId);
    setError(null);
    try {
      const res = await fetch(`/api/preprod-board/columns/${configId}`, { method: 'DELETE' });
      const data = (await res.json()) as { columns?: ColumnRow[]; error?: string; taskCount?: number };
      if (!res.ok) {
        if (data.taskCount && data.taskCount > 0) {
          setError(
            `That column has ${data.taskCount} task${data.taskCount === 1 ? '' : 's'} in it. ` +
            `Move them to another column first.`,
          );
        } else {
          setError(data.error ?? 'Failed to delete column');
        }
        setPendingDeleteId(null);
        return;
      }
      setRows(data.columns ?? []);
      setPendingDeleteId(null);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="modal-box"
        style={{ maxWidth: 640 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Manage Pre-Production Columns</h2>
          <button type="button" className="modal-close" onClick={handleClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ padding: '0 24px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {loading && <p style={{ opacity: 0.6, fontSize: '0.875rem' }}>Loading…</p>}
          {error && (
            <p style={{ color: '#e07070', fontSize: '0.85rem', margin: 0 }}>{error}</p>
          )}

          {!loading && (
            <>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rows.length === 0 && (
                  <li style={{ opacity: 0.55, fontSize: '0.875rem', padding: '0.4rem 0' }}>
                    No columns yet. Add your first below.
                  </li>
                )}
                {rows.map((row, idx) => {
                  const isEditing = editingId === row.configId;
                  const isPendingDelete = pendingDeleteId === row.configId;
                  const isBusy = busyId === row.configId;
                  return (
                    <li
                      key={row.configId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        background: 'rgba(255,255,255,0.03)',
                      }}
                    >
                      {/* Reorder */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <button
                          type="button"
                          onClick={() => void moveRow(idx, -1)}
                          disabled={idx === 0 || isBusy}
                          aria-label="Move up"
                          style={iconBtnStyle(idx === 0)}
                        >▲</button>
                        <button
                          type="button"
                          onClick={() => void moveRow(idx, 1)}
                          disabled={idx === rows.length - 1 || isBusy}
                          aria-label="Move down"
                          style={iconBtnStyle(idx === rows.length - 1)}
                        >▼</button>
                      </div>

                      {/* Color swatch — click cycles to next palette color */}
                      <button
                        type="button"
                        onClick={() => {
                          const next = COLOR_PALETTE[
                            (COLOR_PALETTE.indexOf(row.color as (typeof COLOR_PALETTE)[number]) + 1) %
                              COLOR_PALETTE.length
                          ];
                          void changeColor(row.configId, next);
                        }}
                        title="Click to cycle color"
                        disabled={isBusy}
                        style={{
                          width: 22, height: 22, borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)',
                          background: row.color, cursor: isBusy ? 'wait' : 'pointer', padding: 0,
                        }}
                      />

                      {/* Label */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editingLabel}
                            onChange={(e) => setEditingLabel(e.target.value)}
                            onBlur={() => void commitRename(row.configId)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            style={{
                              width: '100%', padding: '4px 8px', borderRadius: 4,
                              border: '1px solid rgba(255,255,255,0.2)', background: '#1a1a1a',
                              color: 'inherit', fontSize: '0.9rem',
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => startRename(row)}
                            style={{
                              background: 'none', border: 'none', cursor: 'text', padding: '4px 0',
                              color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%',
                            }}
                          >
                            {row.label}
                            <span style={{ marginLeft: 8, opacity: 0.4, fontSize: '0.75rem' }}>
                              {row.slug}
                            </span>
                          </button>
                        )}
                      </div>

                      {/* Delete */}
                      {isPendingDelete ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleDelete(row.configId)}
                            disabled={isBusy}
                            style={{
                              background: 'rgba(224,112,106,0.15)', color: '#e07070',
                              border: '1px solid rgba(224,112,106,0.4)', padding: '3px 10px',
                              borderRadius: 4, fontSize: '0.75rem', cursor: 'pointer',
                            }}
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(null)}
                            style={{
                              background: 'none', border: 'none', color: 'inherit',
                              opacity: 0.6, fontSize: '0.75rem', cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(row.configId)}
                          disabled={isBusy}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: '#e07070', opacity: 0.75, fontSize: '0.75rem', padding: '2px 6px',
                          }}
                          aria-label="Delete column"
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Add column row */}
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 8px', borderTop: '1px solid rgba(255,255,255,0.08)',
                  paddingTop: 14, marginTop: 4,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    const idx = COLOR_PALETTE.indexOf(draftColor as (typeof COLOR_PALETTE)[number]);
                    setDraftColor(COLOR_PALETTE[(idx + 1) % COLOR_PALETTE.length]);
                  }}
                  title="Click to cycle color"
                  style={{
                    width: 22, height: 22, borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)',
                    background: draftColor, cursor: 'pointer', padding: 0,
                  }}
                />
                <input
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="New column label…"
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
                  style={{
                    flex: 1, padding: '6px 10px', borderRadius: 4,
                    border: '1px solid rgba(255,255,255,0.15)', background: '#1a1a1a',
                    color: 'inherit', fontSize: '0.875rem',
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleAdd()}
                  disabled={adding || !draftLabel.trim()}
                  className="modal-btn-primary"
                  style={{ padding: '6px 14px', fontSize: '0.85rem' }}
                >
                  {adding ? 'Adding…' : 'Add'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function iconBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 18, height: 14, padding: 0, lineHeight: '12px',
    fontSize: 9, background: 'none', border: 'none', color: 'inherit',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.25 : 0.65,
  };
}
