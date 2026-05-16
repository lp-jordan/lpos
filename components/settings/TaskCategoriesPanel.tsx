'use client';

import { useEffect, useState } from 'react';

interface TaskCategory {
  categoryId: string;
  label: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function TaskCategoriesPanel() {
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newLabel, setNewLabel]     = useState('');
  const [adding, setAdding]         = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [busyId, setBusyId]         = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/task-categories');
      if (!res.ok) throw new Error('Failed to load categories.');
      const data = await res.json() as { categories: TaskCategory[] };
      setCategories(data.categories);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleAdd() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    setActionError(null);
    try {
      const res = await fetch('/api/task-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const data = await res.json() as { category?: TaskCategory; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add category.');
      if (data.category) setCategories((prev) => [...prev, data.category!]);
      setNewLabel('');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  function startEdit(category: TaskCategory) {
    setEditingId(category.categoryId);
    setEditingLabel(category.label);
    setActionError(null);
  }

  async function commitEdit() {
    if (!editingId) return;
    const label = editingLabel.trim();
    if (!label) { setEditingId(null); return; }
    setBusyId(editingId);
    setActionError(null);
    try {
      const res = await fetch(`/api/task-categories/${encodeURIComponent(editingId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const data = await res.json() as { category?: TaskCategory; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to rename.');
      if (data.category) {
        setCategories((prev) => prev.map((c) => (c.categoryId === editingId ? data.category! : c)));
      }
      setEditingId(null);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(category: TaskCategory) {
    if (!window.confirm(`Delete "${category.label}"? This can't be undone.`)) return;
    setBusyId(category.categoryId);
    setActionError(null);
    try {
      const res = await fetch(`/api/task-categories/${encodeURIComponent(category.categoryId)}`, { method: 'DELETE' });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete.');
      setCategories((prev) => prev.filter((c) => c.categoryId !== category.categoryId));
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function move(category: TaskCategory, direction: -1 | 1) {
    const idx = categories.findIndex((c) => c.categoryId === category.categoryId);
    const newIdx = idx + direction;
    if (idx === -1 || newIdx < 0 || newIdx >= categories.length) return;
    const reordered = [...categories];
    const [removed] = reordered.splice(idx, 1);
    reordered.splice(newIdx, 0, removed);
    setCategories(reordered);  // optimistic
    setActionError(null);
    try {
      const res = await fetch('/api/task-categories/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: reordered.map((c) => c.categoryId) }),
      });
      const data = await res.json() as { categories?: TaskCategory[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to reorder.');
      if (data.categories) setCategories(data.categories);
    } catch (err) {
      setActionError((err as Error).message);
      // Roll back to authoritative state on failure
      void load();
    }
  }

  return (
    <div className="storage-settings-card">
      <div>
        <h2 className="storage-settings-section-title">Platform task categories</h2>
        <p className="storage-settings-muted">
          The category list that appears in the New Task modal for Platform tasks.
          Renaming cascades to every task currently tagged with the old name.
          Deletion is blocked if any task still uses the category — reassign first.
        </p>
      </div>

      {loading && <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{error}</p>}
      {actionError && <p style={{ color: 'var(--color-error, #e55)', marginTop: '0.5rem' }}>{actionError}</p>}

      {!loading && categories.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0' }}>
          {categories.map((c, idx) => {
            const isEditing = editingId === c.categoryId;
            const isBusy = busyId === c.categoryId;
            return (
              <li
                key={c.categoryId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem 0',
                  borderBottom: '1px solid var(--color-border, #333)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => void move(c, -1)}
                    disabled={idx === 0 || isBusy}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', opacity: idx === 0 ? 0.3 : 1, fontSize: '0.75rem', padding: 0, lineHeight: 1 }}
                    aria-label="Move up"
                  >▲</button>
                  <button
                    type="button"
                    onClick={() => void move(c, 1)}
                    disabled={idx === categories.length - 1 || isBusy}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', opacity: idx === categories.length - 1 ? 0.3 : 1, fontSize: '0.75rem', padding: 0, lineHeight: 1 }}
                    aria-label="Move down"
                  >▼</button>
                </div>

                {isEditing ? (
                  <input
                    type="text"
                    value={editingLabel}
                    onChange={(e) => setEditingLabel(e.target.value)}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitEdit();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    autoFocus
                    disabled={isBusy}
                    style={{
                      flex: 1,
                      padding: '0.3rem 0.5rem',
                      border: '1px solid var(--color-border, #444)',
                      borderRadius: 4,
                      background: 'var(--color-input-bg, #1a1a1a)',
                      color: 'inherit',
                      fontSize: '0.9rem',
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(c)}
                    disabled={isBusy}
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'inherit',
                      fontSize: '0.9rem',
                      padding: '0.3rem 0',
                    }}
                  >
                    {c.label}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleRemove(c)}
                  disabled={isBusy}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--color-error, #e55)',
                    fontSize: '0.8rem',
                    opacity: isBusy ? 0.4 : 1,
                  }}
                >
                  {isBusy ? '…' : 'Delete'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && categories.length === 0 && !error && (
        <p className="storage-settings-muted" style={{ marginTop: '1rem' }}>
          No categories yet. Add one below.
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
          placeholder="New category name"
          disabled={adding}
          style={{
            flex: 1,
            padding: '0.4rem 0.7rem',
            border: '1px solid var(--color-border, #444)',
            borderRadius: 6,
            background: 'var(--color-input-bg, #1a1a1a)',
            color: 'inherit',
            fontSize: '0.9rem',
          }}
        />
        <button
          type="button"
          className="storage-settings-primary"
          onClick={() => void handleAdd()}
          disabled={adding || !newLabel.trim()}
        >
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  );
}
