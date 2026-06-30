'use client';

/**
 * Cleanup pass: DeliverablesPanelBody — shell-less content for the
 * unified DeliverablesHub. Lists every review-link deliverable for the
 * project with inline edit affordances (rename, downloads toggle, add/remove
 * assets) and a "New version" badge when any contained asset was re-uploaded
 * after the deliverable was created.
 *
 * The slide-in shell + tab control live in DeliverablesHub. This component is
 * just the body — header-less, can be mounted inside any container that
 * provides the .sh-panel-body styling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MediaAsset } from '@/lib/models/media-asset';
import type { DeliverableWithAssets } from '@/lib/models/deliverable';
import type { InternalReviewWithAssets } from '@/lib/models/internal-review';
import { DeliverableModal } from '@/components/projects/DeliverableModal';

interface BodyProps {
  projectId: string;
  assets: MediaAsset[];
  /** True when this body is currently visible. Gates the initial fetch. */
  active: boolean;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function DeliverablesPanelBody({ projectId, assets, active }: Readonly<BodyProps>) {
  const router = useRouter();
  const [deliverables, setDeliverables] = useState<DeliverableWithAssets[]>([]);
  // Internal reviews — LPOS-hosted, additive to the Frame.io deliverables above.
  const [internalReviews, setInternalReviews] = useState<InternalReviewWithAssets[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Edit-assets modal: deliverableId or null
  const [editAssetsFor, setEditAssetsFor] = useState<DeliverableWithAssets | null>(null);
  // Internal-review edit-assets modal
  const [editInternalFor, setEditInternalFor] = useState<InternalReviewWithAssets | null>(null);

  const fetchDeliverables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Frame.io deliverables and internal reviews are independent stores;
      // fetch both in parallel and merge into the one Review Links list.
      const [delRes, intRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/deliverables`),
        fetch(`/api/projects/${projectId}/internal-reviews`),
      ]);
      const delData = await delRes.json() as { deliverables?: DeliverableWithAssets[]; error?: string };
      if (!delRes.ok) {
        setError(delData.error ?? 'Failed to load deliverables.');
        return;
      }
      setDeliverables(delData.deliverables ?? []);
      if (intRes.ok) {
        const intData = await intRes.json() as { internalReviews?: InternalReviewWithAssets[] };
        setInternalReviews(intData.internalReviews ?? []);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (active) void fetchDeliverables();
  }, [active, fetchDeliverables]);

  function handleOpenInternal(reviewId: string) {
    router.push(`/internal-review/${reviewId}`);
  }

  function handleCopyInternal(reviewId: string) {
    const url = `${window.location.origin}/internal-review/${reviewId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedId(reviewId);
    setTimeout(() => setCopiedId((cur) => (cur === reviewId ? null : cur)), 2000);
  }

  async function handleToggleInternalRevoked(review: InternalReviewWithAssets) {
    const nextStatus = review.status === 'revoked' ? 'active' : 'revoked';
    // Optimistic flip.
    setInternalReviews((prev) => prev.map((r) =>
      r.reviewId === review.reviewId ? { ...r, status: nextStatus } : r,
    ));
    try {
      const res = await fetch(`/api/projects/${projectId}/internal-reviews/${review.reviewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(`Update failed: ${(err as Error).message}`);
      void fetchDeliverables();
    }
  }

  async function handleDeleteInternal(reviewId: string, name: string) {
    if (!confirm(`Delete "${name}"? The internal review link will stop working immediately.`)) return;
    setDeletingId(reviewId);
    try {
      const res = await fetch(`/api/projects/${projectId}/internal-reviews/${reviewId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setInternalReviews((prev) => prev.filter((r) => r.reviewId !== reviewId));
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to delete.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRenameInternal(reviewId: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const previous = internalReviews.find((r) => r.reviewId === reviewId)?.name;
    setInternalReviews((prev) => prev.map((r) =>
      r.reviewId === reviewId ? { ...r, name: trimmed } : r,
    ));
    try {
      const res = await fetch(`/api/projects/${projectId}/internal-reviews/${reviewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(`Rename failed: ${(err as Error).message}`);
      if (previous !== undefined) {
        setInternalReviews((prev) => prev.map((r) =>
          r.reviewId === reviewId ? { ...r, name: previous } : r,
        ));
      }
    }
  }

  function handleCopy(deliverableId: string, url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedId(deliverableId);
    setTimeout(() => setCopiedId((cur) => (cur === deliverableId ? null : cur)), 2000);
  }

  async function handleDelete(deliverableId: string, name: string) {
    if (!confirm(`Delete "${name}"? The Frame.io share will be deleted too — the link will stop working immediately.`)) return;
    setDeletingId(deliverableId);
    try {
      const res = await fetch(`/api/projects/${projectId}/deliverables/${deliverableId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDeliverables((prev) => prev.filter((d) => d.deliverableId !== deliverableId));
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Failed to delete.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRename(deliverableId: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    // Optimistic update; rollback on failure.
    const previous = deliverables.find((d) => d.deliverableId === deliverableId)?.name;
    setDeliverables((prev) => prev.map((d) =>
      d.deliverableId === deliverableId ? { ...d, name: trimmed } : d,
    ));
    try {
      const res = await fetch(`/api/projects/${projectId}/deliverables/${deliverableId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(`Rename failed: ${(err as Error).message}`);
      if (previous !== undefined) {
        setDeliverables((prev) => prev.map((d) =>
          d.deliverableId === deliverableId ? { ...d, name: previous } : d,
        ));
      }
    }
  }

  const modalAssets = useMemo(() => assets.map((a) => ({
    assetId: a.assetId,
    name: a.name,
    hasFrameio: Boolean(a.frameio.assetId || a.frameio.stackId),
  })), [assets]);

  // "New version" detection (E7).
  const assetUploadedAtById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) if (a.frameio.uploadedAt) m.set(a.assetId, a.frameio.uploadedAt);
    return m;
  }, [assets]);

  function hasNewVersionSince(d: DeliverableWithAssets): boolean {
    const createdMs = new Date(d.createdAt).getTime();
    for (const member of d.assets) {
      const uploadedAt = assetUploadedAtById.get(member.assetId);
      if (uploadedAt && new Date(uploadedAt).getTime() > createdMs) return true;
    }
    return false;
  }

  return (
    <>
      <div className="sh-panel-body">
        <button
          type="button"
          className="sh-btn sh-btn--primary sh-new-btn"
          onClick={() => setShowNewModal(true)}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Review Link
        </button>

        {loading && <p className="sh-empty">Loading…</p>}
        {error && <p className="sh-error">{error}</p>}

        {!loading && !error && deliverables.length === 0 && internalReviews.length === 0 && (
          <p className="sh-empty">
            No review links yet. Create a Frame.io review link to send to a client, or an
            Internal Review to share with your team inside LPOS.
          </p>
        )}

        {deliverables.length > 0 && (
          <div className="deliverables-list">
            {deliverables.map((d) => (
              <DeliverableRow
                key={d.deliverableId}
                deliverable={d}
                copiedId={copiedId}
                deletingId={deletingId}
                hasNewVersion={hasNewVersionSince(d)}
                onCopy={handleCopy}
                onDelete={handleDelete}
                onRename={handleRename}
                onEditAssets={() => setEditAssetsFor(d)}
              />
            ))}
          </div>
        )}

        {internalReviews.length > 0 && (
          <div className="deliverables-list">
            {internalReviews.map((r) => (
              <InternalReviewRow
                key={r.reviewId}
                review={r}
                copiedId={copiedId}
                deletingId={deletingId}
                onOpen={() => handleOpenInternal(r.reviewId)}
                onCopy={() => handleCopyInternal(r.reviewId)}
                onDelete={() => handleDeleteInternal(r.reviewId, r.name)}
                onRename={(name) => handleRenameInternal(r.reviewId, name)}
                onToggleRevoked={() => void handleToggleInternalRevoked(r)}
                onEditAssets={() => setEditInternalFor(r)}
              />
            ))}
          </div>
        )}
      </div>

      {showNewModal && (
        <DeliverableModal
          projectId={projectId}
          availableAssets={modalAssets}
          initiallySelectedAssetIds={[]}
          defaultName=""
          onClose={() => setShowNewModal(false)}
          onCreated={() => { void fetchDeliverables(); }}
          onInternalCreated={() => { void fetchDeliverables(); }}
        />
      )}

      {editAssetsFor && (
        <EditAssetsModal
          projectId={projectId}
          deliverable={editAssetsFor}
          allAssets={assets}
          onClose={() => setEditAssetsFor(null)}
          onChanged={() => { void fetchDeliverables(); }}
        />
      )}

      {editInternalFor && (
        <InternalEditAssetsModal
          projectId={projectId}
          review={editInternalFor}
          allAssets={assets}
          onClose={() => setEditInternalFor(null)}
          onChanged={() => { void fetchDeliverables(); }}
        />
      )}
    </>
  );
}

// ── DeliverableRow ───────────────────────────────────────────────────────────

function DeliverableRow({
  deliverable: d,
  copiedId,
  deletingId,
  hasNewVersion,
  onCopy,
  onDelete,
  onRename,
  onEditAssets,
}: {
  deliverable: DeliverableWithAssets;
  copiedId: string | null;
  deletingId: string | null;
  hasNewVersion: boolean;
  onCopy: (id: string, url: string) => void;
  onDelete: (id: string, name: string) => void;
  onRename: (id: string, newName: string) => void;
  onEditAssets: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(d.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  function startRename() {
    setNameDraft(d.name);
    setRenaming(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  }
  function commitRename() {
    setRenaming(false);
    if (nameDraft.trim() && nameDraft.trim() !== d.name) {
      onRename(d.deliverableId, nameDraft.trim());
    } else {
      setNameDraft(d.name);
    }
  }
  function cancelRename() {
    setRenaming(false);
    setNameDraft(d.name);
  }

  return (
    <div className="deliverable-row">
      <div className="deliverable-row-main">
        <div className="deliverable-row-name-line">
          {renaming ? (
            <input
              ref={nameInputRef}
              className="deliverable-row-name-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
              }}
            />
          ) : (
            <button
              type="button"
              className="deliverable-row-name-btn"
              onClick={startRename}
              title="Click to rename"
            >
              {d.name}
            </button>
          )}
          {hasNewVersion && (
            <span
              className="deliverable-row-new-badge"
              title="An asset in this review link has been re-uploaded since the link was created. The link auto-resolves to the latest version."
            >
              New version
            </span>
          )}
        </div>
        <button
          type="button"
          className="deliverable-row-meta-btn"
          onClick={onEditAssets}
          title="Edit which assets are in this review link"
        >
          {d.assetCount} asset{d.assetCount === 1 ? '' : 's'}
        </button>
        <span className="deliverable-row-meta">
          {formatDate(d.createdAt)}
          {d.expiresAt && ` · expires ${formatDate(d.expiresAt)}`}
        </span>
        <span className="deliverable-row-url" title={d.shortUrl}>{d.shortUrl}</span>
      </div>
      <div className="deliverable-row-actions">
        <a
          href={d.shortUrl}
          target="_blank"
          rel="noreferrer"
          className="sh-card-action-btn"
          title="Open in Frame.io"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Open
        </a>
        <button
          type="button"
          className={`sh-card-action-btn${copiedId === d.deliverableId ? ' sh-card-action-btn--success' : ' sh-card-action-btn--accent'}`}
          onClick={() => onCopy(d.deliverableId, d.shortUrl)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          {copiedId === d.deliverableId ? '✓' : 'Copy'}
        </button>
        <button
          type="button"
          className="sh-card-action-btn sh-card-action-btn--danger"
          onClick={() => onDelete(d.deliverableId, d.name)}
          disabled={deletingId === d.deliverableId}
          title="Delete review link"
          aria-label="Delete review link"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── EditAssetsModal ──────────────────────────────────────────────────────────

function EditAssetsModal({
  projectId,
  deliverable,
  allAssets,
  onClose,
  onChanged,
}: {
  projectId: string;
  deliverable: DeliverableWithAssets;
  allAssets: MediaAsset[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const currentIds = useMemo(() => new Set(deliverable.assets.map((a) => a.assetId)), [deliverable]);
  const [selected, setSelected] = useState<Set<string>>(currentIds);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(assetId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  async function commitChanges() {
    setWorking(true);
    setError(null);
    try {
      // Diff against the original membership.
      const toAdd = [...selected].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !selected.has(id));

      for (const assetId of toAdd) {
        const res = await fetch(`/api/projects/${projectId}/deliverables/${deliverable.deliverableId}/assets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `add failed (HTTP ${res.status})`);
        }
      }
      for (const assetId of toRemove) {
        const res = await fetch(
          `/api/projects/${projectId}/deliverables/${deliverable.deliverableId}/assets/${assetId}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `remove failed (HTTP ${res.status})`);
        }
      }
      onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sh-modal-backdrop" onClick={onClose} role="presentation">
      <div className="sh-modal" role="dialog" aria-modal="true" aria-label="Edit assets" onClick={(e) => e.stopPropagation()}>
        <div className="sh-modal-header">
          <span>Edit assets — {deliverable.name}</span>
          <button type="button" className="sh-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="sh-modal-body">
          <div className="sh-modal-field">
            <label className="sh-modal-label">
              Assets ({selected.size} of {allAssets.filter((a) => a.frameio.assetId || a.frameio.stackId).length} on Frame.io)
            </label>
            <div className="sh-modal-asset-list">
              {allAssets.map((a) => {
                const hasFrameio = Boolean(a.frameio.assetId || a.frameio.stackId);
                return (
                  <label
                    key={a.assetId}
                    className={`sh-modal-asset-row${!hasFrameio ? ' deliverable-modal-asset-row--disabled' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(a.assetId)}
                      disabled={!hasFrameio}
                      onChange={() => toggle(a.assetId)}
                    />
                    <span>{a.name}</span>
                    {!hasFrameio && <span className="deliverable-modal-asset-note">— not on Frame.io yet</span>}
                  </label>
                );
              })}
            </div>
          </div>
          {error && <p className="sh-error">{error}</p>}
        </div>
        <div className="sh-modal-footer">
          <button type="button" className="sh-btn" onClick={onClose} disabled={working}>Cancel</button>
          <button
            type="button"
            className="sh-btn sh-btn--primary"
            onClick={() => void commitChanges()}
            disabled={working || selected.size === 0}
          >
            {working ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── InternalReviewRow ────────────────────────────────────────────────────────
// LPOS-hosted review bundle. Mirrors DeliverableRow but: an "Internal" badge,
// Open via in-app navigation (not a Frame.io link), and a Revoke toggle instead
// of an expiry. Revoked rows are dimmed and labelled.

function InternalReviewRow({
  review: r,
  copiedId,
  deletingId,
  onOpen,
  onCopy,
  onDelete,
  onRename,
  onToggleRevoked,
  onEditAssets,
}: {
  review: InternalReviewWithAssets;
  copiedId: string | null;
  deletingId: string | null;
  onOpen: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
  onToggleRevoked: () => void;
  onEditAssets: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(r.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const revoked = r.status === 'revoked';

  function startRename() {
    setNameDraft(r.name);
    setRenaming(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  }
  function commitRename() {
    setRenaming(false);
    if (nameDraft.trim() && nameDraft.trim() !== r.name) onRename(nameDraft.trim());
    else setNameDraft(r.name);
  }
  function cancelRename() {
    setRenaming(false);
    setNameDraft(r.name);
  }

  return (
    <div className={`deliverable-row deliverable-row--internal${revoked ? ' deliverable-row--revoked' : ''}`}>
      <div className="deliverable-row-main">
        <div className="deliverable-row-name-line">
          {renaming ? (
            <input
              ref={nameInputRef}
              className="deliverable-row-name-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
              }}
            />
          ) : (
            <button
              type="button"
              className="deliverable-row-name-btn"
              onClick={startRename}
              title="Click to rename"
            >
              {r.name}
            </button>
          )}
          <span className="deliverable-row-internal-badge" title="LPOS-hosted internal review — no Frame.io">
            Internal
          </span>
          {revoked && (
            <span className="deliverable-row-revoked-badge" title="This internal review link has been revoked">
              Revoked
            </span>
          )}
        </div>
        <button
          type="button"
          className="deliverable-row-meta-btn"
          onClick={onEditAssets}
          title="Edit which assets are in this internal review"
        >
          {r.assetCount} asset{r.assetCount === 1 ? '' : 's'}
        </button>
        <span className="deliverable-row-meta">{formatDate(r.createdAt)}</span>
      </div>
      <div className="deliverable-row-actions">
        <button
          type="button"
          className="sh-card-action-btn"
          onClick={onOpen}
          title="Open the internal review page in LPOS"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Open
        </button>
        <button
          type="button"
          className={`sh-card-action-btn${copiedId === r.reviewId ? ' sh-card-action-btn--success' : ' sh-card-action-btn--accent'}`}
          onClick={onCopy}
          title="Copy the internal review link"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          {copiedId === r.reviewId ? '✓' : 'Copy'}
        </button>
        <button
          type="button"
          className="sh-card-action-btn"
          onClick={onToggleRevoked}
          title={revoked ? 'Reactivate this internal review link' : 'Revoke this internal review link'}
        >
          {revoked ? 'Reactivate' : 'Revoke'}
        </button>
        <button
          type="button"
          className="sh-card-action-btn sh-card-action-btn--danger"
          onClick={onDelete}
          disabled={deletingId === r.reviewId}
          title="Delete internal review"
          aria-label="Delete internal review"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── InternalEditAssetsModal ──────────────────────────────────────────────────
// Like EditAssetsModal but for internal reviews: ALL project assets are eligible
// (no Frame.io gating), and it commits the full membership in one PATCH.

function InternalEditAssetsModal({
  projectId,
  review,
  allAssets,
  onClose,
  onChanged,
}: {
  projectId: string;
  review: InternalReviewWithAssets;
  allAssets: MediaAsset[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const currentIds = useMemo(() => new Set(review.assets.map((a) => a.assetId)), [review]);
  const [selected, setSelected] = useState<Set<string>>(currentIds);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(assetId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  async function commitChanges() {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/internal-reviews/${review.reviewId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [...selected] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `save failed (HTTP ${res.status})`);
      }
      onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sh-modal-backdrop" onClick={onClose} role="presentation">
      <div className="sh-modal" role="dialog" aria-modal="true" aria-label="Edit assets" onClick={(e) => e.stopPropagation()}>
        <div className="sh-modal-header">
          <span>Edit assets — {review.name}</span>
          <button type="button" className="sh-modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="sh-modal-body">
          <div className="sh-modal-field">
            <label className="sh-modal-label">
              Assets ({selected.size} of {allAssets.length} selected)
            </label>
            <div className="sh-modal-asset-list">
              {allAssets.map((a) => (
                <label key={a.assetId} className="sh-modal-asset-row">
                  <input
                    type="checkbox"
                    checked={selected.has(a.assetId)}
                    onChange={() => toggle(a.assetId)}
                  />
                  <span>{a.name}</span>
                </label>
              ))}
            </div>
          </div>
          {error && <p className="sh-error">{error}</p>}
        </div>
        <div className="sh-modal-footer">
          <button type="button" className="sh-btn" onClick={onClose} disabled={working}>Cancel</button>
          <button
            type="button"
            className="sh-btn sh-btn--primary"
            onClick={() => void commitChanges()}
            disabled={working || selected.size === 0}
          >
            {working ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
