'use client';

import { useState, useCallback } from 'react';
import type { WishItem } from '@/lib/models/wish';
import type { UserSummary } from '@/lib/models/user';

function StarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M12 2l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.1l-5.9 3.1 1.2-6.6L2.5 9l6.6-.9z" />
    </svg>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface PanelProps {
  currentUser: UserSummary;
  onClose: () => void;
}

function WishListPanel({ currentUser, onClose }: Readonly<PanelProps>) {
  const [wishes, setWishes] = useState<WishItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/wishes');
      if (!res.ok) throw new Error('Failed to load wishes');
      const data = await res.json() as { wishes: WishItem[] };
      setWishes(data.wishes);
    } catch {
      setError('Could not load wish list.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on first render
  useState(() => { void load(); });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/wishes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined }),
      });
      if (!res.ok) throw new Error('Failed to submit wish');
      setTitle('');
      setDescription('');
      await load();
    } catch {
      setError('Could not submit wish. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(wish: WishItem) {
    try {
      const res = await fetch(`/api/wishes/${wish.wishId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: !wish.completed }),
      });
      if (!res.ok) throw new Error('Failed to update');
      setWishes((prev) =>
        prev
          ? prev.map((w) =>
              w.wishId === wish.wishId ? { ...w, completed: !w.completed } : w,
            )
          : prev,
      );
    } catch {
      setError('Could not update wish.');
    }
  }

  async function handleDelete(wishId: string) {
    try {
      const res = await fetch(`/api/wishes/${wishId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      setWishes((prev) => (prev ? prev.filter((w) => w.wishId !== wishId) : prev));
    } catch {
      setError('Could not delete wish.');
    }
  }

  const open = wishes?.filter((w) => !w.completed) ?? [];
  const done = wishes?.filter((w) => w.completed) ?? [];

  return (
    <div className="wishlist-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Wish List">
      <div className="wishlist-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="wishlist-header">
          <div className="wishlist-header-title">
            <StarIcon />
            <span>Wish List</span>
          </div>
          <button type="button" className="wishlist-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Submit form */}
        <form className="wishlist-form" onSubmit={handleSubmit}>
          <input
            className="wishlist-input"
            type="text"
            placeholder="What would you like to see?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
          />
          <textarea
            className="wishlist-textarea"
            placeholder="More detail (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={1000}
          />
          <button type="submit" className="wishlist-submit" disabled={submitting || !title.trim()}>
            {submitting ? 'Submitting…' : 'Submit wish'}
          </button>
        </form>

        {error && <p className="wishlist-error">{error}</p>}

        {/* List */}
        <div className="wishlist-items">
          {loading && <p className="wishlist-empty">Loading…</p>}

          {!loading && wishes !== null && open.length === 0 && done.length === 0 && (
            <p className="wishlist-empty">No wishes yet. Be the first!</p>
          )}

          {open.length > 0 && (
            <section>
              <p className="wishlist-section-label">Open</p>
              {open.map((wish) => (
                <WishRow
                  key={wish.wishId}
                  wish={wish}
                  currentUserId={currentUser.id}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
            </section>
          )}

          {done.length > 0 && (
            <section>
              <p className="wishlist-section-label">Done</p>
              {done.map((wish) => (
                <WishRow
                  key={wish.wishId}
                  wish={wish}
                  currentUserId={currentUser.id}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  wish: WishItem;
  currentUserId: string;
  onToggle: (wish: WishItem) => void;
  onDelete: (wishId: string) => void;
}

function WishRow({ wish, currentUserId, onToggle, onDelete }: Readonly<RowProps>) {
  return (
    <div className={`wishlist-row${wish.completed ? ' wishlist-row--done' : ''}`}>
      <button
        type="button"
        className="wishlist-check"
        onClick={() => onToggle(wish)}
        aria-label={wish.completed ? 'Mark as open' : 'Mark as done'}
        title={wish.completed ? 'Mark as open' : 'Mark as done'}
      >
        {wish.completed ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
          </svg>
        )}
      </button>

      <div className="wishlist-row-body">
        <p className="wishlist-row-title">{wish.title}</p>
        {wish.description && <p className="wishlist-row-desc">{wish.description}</p>}
        <p className="wishlist-row-meta">
          {wish.submittedByName} · {formatDate(wish.createdAt)}
          {wish.completedAt && ` · done ${formatDate(wish.completedAt)}`}
        </p>
      </div>

      {wish.submittedBy === currentUserId && (
        <button
          type="button"
          className="wishlist-delete"
          onClick={() => onDelete(wish.wishId)}
          aria-label="Delete wish"
          title="Delete wish"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      )}
    </div>
  );
}

interface Props {
  currentUser: UserSummary;
  home?: boolean;
}

export function WishListButton({ currentUser, home = false }: Readonly<Props>) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`wishlist-btn${home ? ' wishlist-btn--home' : ''}`}
        onClick={() => setOpen(true)}
        aria-label="Wish list"
        title="Wish list — request a feature"
      >
        <StarIcon />
      </button>

      {open && <WishListPanel currentUser={currentUser} onClose={() => setOpen(false)} />}
    </>
  );
}
