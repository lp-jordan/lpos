'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';

/** What the user chose in the version-confirm modal:
 *  - 'version'  → register as a new version of the matched asset (replace pipeline mappings)
 *  - 'separate' → register as a brand-new, unrelated asset
 *  - 'cancel'   → don't upload (cancels the batch) */
export type VersionDecision = 'version' | 'separate' | 'cancel';

interface PendingConfirmation {
  asset: MediaAsset;
  currentVersionNumber: number;
  resolve: (decision: VersionDecision) => void;
}

interface VersionConfirmContextValue {
  requestVersionConfirmation: (asset: MediaAsset, currentVersionNumber: number) => Promise<VersionDecision>;
  /** Call at the start of an upload batch to reset the batch-decision flags. */
  startBatch: () => void;
  /** Call when a batch finishes to clean up. */
  endBatch: () => void;
  /** Returns true if the user cancelled out of the version confirm modal during this batch. */
  isBatchCancelled: () => boolean;
}

const VersionConfirmContext = createContext<VersionConfirmContextValue | null>(null);

export function VersionConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [applyAll, setApplyAll] = useState(false);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  // When the user ticks "apply to all", the positive decision they made is
  // auto-applied to every remaining file in the batch.
  const batchDecisionRef = useRef<'version' | 'separate' | null>(null);
  const batchCancelledRef = useRef(false);

  const resetBatch = useCallback(() => {
    batchDecisionRef.current = null;
    batchCancelledRef.current = false;
    setApplyAll(false);
  }, []);

  const startBatch = resetBatch;
  const endBatch = resetBatch;

  const isBatchCancelled = useCallback(() => batchCancelledRef.current, []);

  const requestVersionConfirmation = useCallback(
    (asset: MediaAsset, currentVersionNumber: number): Promise<VersionDecision> => {
      // If the user already chose "apply to all" for this batch, auto-apply it.
      if (batchDecisionRef.current) return Promise.resolve(batchDecisionRef.current);
      // If the user already cancelled this batch, auto-cancel all remaining.
      if (batchCancelledRef.current) return Promise.resolve('cancel');

      return new Promise((resolve) => {
        const entry: PendingConfirmation = { asset, currentVersionNumber, resolve };
        pendingRef.current = entry;
        setPending(entry);
      });
    },
    [],
  );

  function decide(action: 'version' | 'separate', toAll: boolean) {
    if (toAll) batchDecisionRef.current = action;
    pendingRef.current?.resolve(action);
    pendingRef.current = null;
    setPending(null);
    setApplyAll(false);
  }

  function handleClose() {
    batchCancelledRef.current = true;
    pendingRef.current?.resolve('cancel');
    pendingRef.current = null;
    setPending(null);
    setApplyAll(false);
  }

  return (
    <VersionConfirmContext.Provider value={{ requestVersionConfirmation, startBatch, endBatch, isBatchCancelled }}>
      {children}
      {pending && (
        <VersionConfirmModal
          asset={pending.asset}
          currentVersionNumber={pending.currentVersionNumber}
          applyAll={applyAll}
          onApplyAllChange={setApplyAll}
          onCreateVersion={() => decide('version', applyAll)}
          onUploadSeparate={() => decide('separate', applyAll)}
          onClose={handleClose}
        />
      )}
    </VersionConfirmContext.Provider>
  );
}

function VersionConfirmModal({
  asset,
  currentVersionNumber,
  applyAll,
  onApplyAllChange,
  onCreateVersion,
  onUploadSeparate,
  onClose,
}: {
  asset: MediaAsset;
  currentVersionNumber: number;
  applyAll: boolean;
  onApplyAllChange: (v: boolean) => void;
  onCreateVersion: () => void;
  onUploadSeparate: () => void;
  onClose: () => void;
}) {
  const baseName = asset.name.replace(/\.[^.]+$/, '').replace(/_?v\d+$/i, '') || asset.name;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">This looks like a version</h2>
        </div>
        <p className="modal-body-text">
          {`"${baseName}" already exists in this project (currently version ${currentVersionNumber}). Register this file as version ${currentVersionNumber + 1} (replacing downstream Frame.io and LeaderPass mappings), or upload it as a separate, unrelated asset?`}
        </p>
        <label className="version-confirm-all-label">
          <input
            type="checkbox"
            checked={applyAll}
            onChange={(e) => onApplyAllChange(e.target.checked)}
          />
          Apply to all remaining files in this batch
        </label>
        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="modal-btn-secondary" onClick={onUploadSeparate}>
            Upload as separate asset
          </button>
          <button type="button" className="modal-btn-primary" onClick={onCreateVersion}>
            Create Version {currentVersionNumber + 1}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useVersionConfirm(): VersionConfirmContextValue {
  const ctx = useContext(VersionConfirmContext);
  if (!ctx) throw new Error('useVersionConfirm must be used within a VersionConfirmProvider');
  return ctx;
}
