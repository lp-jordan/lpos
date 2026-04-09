'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';

interface PendingConfirmation {
  asset: MediaAsset;
  currentVersionNumber: number;
  resolve: (accepted: boolean) => void;
}

interface VersionConfirmContextValue {
  requestVersionConfirmation: (asset: MediaAsset, currentVersionNumber: number) => Promise<boolean>;
  /** Call at the start of an upload batch to reset the "confirm all" flag. */
  startBatch: () => void;
  /** Call when a batch finishes to clean up. */
  endBatch: () => void;
  /** Returns true if the user cancelled out of the version confirm modal during this batch. */
  isBatchCancelled: () => boolean;
}

const VersionConfirmContext = createContext<VersionConfirmContextValue | null>(null);

export function VersionConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  const confirmAllRef = useRef(false);
  const batchCancelledRef = useRef(false);

  const startBatch = useCallback(() => {
    confirmAllRef.current = false;
    batchCancelledRef.current = false;
    setConfirmAll(false);
  }, []);

  const endBatch = useCallback(() => {
    confirmAllRef.current = false;
    batchCancelledRef.current = false;
    setConfirmAll(false);
  }, []);

  const isBatchCancelled = useCallback(() => batchCancelledRef.current, []);

  const requestVersionConfirmation = useCallback(
    (asset: MediaAsset, currentVersionNumber: number): Promise<boolean> => {
      // If the user already said "confirm all" for this batch, auto-approve.
      if (confirmAllRef.current) return Promise.resolve(true);
      // If the user already cancelled this batch, auto-decline all remaining.
      if (batchCancelledRef.current) return Promise.resolve(false);

      return new Promise((resolve) => {
        const entry: PendingConfirmation = { asset, currentVersionNumber, resolve };
        pendingRef.current = entry;
        setPending(entry);
      });
    },
    [],
  );

  function handleConfirm(applyToAll: boolean) {
    if (applyToAll) {
      confirmAllRef.current = true;
    }
    pendingRef.current?.resolve(true);
    pendingRef.current = null;
    setPending(null);
    setConfirmAll(false);
  }

  function handleClose() {
    batchCancelledRef.current = true;
    pendingRef.current?.resolve(false);
    pendingRef.current = null;
    setPending(null);
    setConfirmAll(false);
  }

  return (
    <VersionConfirmContext.Provider value={{ requestVersionConfirmation, startBatch, endBatch, isBatchCancelled }}>
      {children}
      {pending && (
        <VersionConfirmModal
          asset={pending.asset}
          currentVersionNumber={pending.currentVersionNumber}
          confirmAll={confirmAll}
          onConfirmAllChange={setConfirmAll}
          onConfirm={() => handleConfirm(confirmAll)}
          onClose={handleClose}
        />
      )}
    </VersionConfirmContext.Provider>
  );
}

function VersionConfirmModal({
  asset,
  currentVersionNumber,
  confirmAll,
  onConfirmAllChange,
  onConfirm,
  onClose,
}: {
  asset: MediaAsset;
  currentVersionNumber: number;
  confirmAll: boolean;
  onConfirmAllChange: (v: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Create New Version</h2>
        </div>
        <p className="modal-body-text">
          {`"${asset.name.replace(/\.[^.]+$/, '').replace(/_?v\d+$/i, '') || asset.name}" already exists in this project (currently version ${currentVersionNumber}). Register this file as version ${currentVersionNumber + 1} and replace downstream pipeline mappings for future Frame.io and LeaderPass delivery?`}
        </p>
        <label className="version-confirm-all-label">
          <input
            type="checkbox"
            checked={confirmAll}
            onChange={(e) => onConfirmAllChange(e.target.checked)}
          />
          Confirm all remaining files in this batch
        </label>
        <div className="modal-actions">
          <button type="button" className="modal-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="modal-btn-primary" onClick={onConfirm}>
            Create Version
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
