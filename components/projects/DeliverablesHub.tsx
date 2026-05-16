'use client';

/**
 * Cleanup pass: unified Deliverables hub.
 *
 * Replaces the prior pair of toolbar buttons ("Reviews" → SharesPanel,
 * "Delivery" → DeliveryPanel) with a single "Deliverables" button. Two tabs
 * inside the panel separate the two concepts visually:
 *
 *   - Review Links — Frame.io-backed in-progress review URLs (blue accent)
 *   - Deliveries — R2-zip final handoffs (gold accent)
 *
 * Both bodies are body-only components (no shell) — this hub provides the
 * single slide-in shell, header, and tab control.
 */

import { useEffect, useState } from 'react';
import type { MediaAsset } from '@/lib/models/media-asset';
import { DeliverablesPanelBody } from '@/components/projects/DeliverablesPanel';
import { DeliveryPanelBody } from '@/components/projects/DeliveryPanel';

type Tab = 'reviews' | 'deliveries';

interface Props {
  projectId: string;
  assets: MediaAsset[];
  open: boolean;
  onClose: () => void;
  /** Asset list for a pending CreateDeliveryModal — when set, the Deliveries
   *  tab opens automatically with these assets pre-selected. */
  pendingDeliveryCreate: MediaAsset[] | null;
  onPendingDeliveryConsumed: () => void;
}

export function DeliverablesHub({
  projectId,
  assets,
  open,
  onClose,
  pendingDeliveryCreate,
  onPendingDeliveryConsumed,
}: Readonly<Props>) {
  const [tab, setTab] = useState<Tab>('reviews');

  // If a delivery create is requested, snap to the Deliveries tab automatically.
  // The DeliveryPanelBody picks up pendingCreate via its prop and opens its modal.
  useEffect(() => {
    if (pendingDeliveryCreate !== null && open) setTab('deliveries');
  }, [pendingDeliveryCreate, open]);

  return (
    <>
      {open && <div className="sh-backdrop" onClick={onClose} aria-hidden="true" />}

      <aside
        className={`sh-panel${open ? ' sh-panel--open' : ''}`}
        role="dialog"
        aria-label="Deliverables"
      >
        <div className="sh-panel-header">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          <span className="sh-panel-title">Deliverables</span>
          <div className="sh-panel-header-actions">
            <button
              type="button"
              className="sh-icon-btn"
              onClick={onClose}
              aria-label="Close deliverables panel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Tab control */}
        <div className="deliverables-hub-tabs" role="tablist" aria-label="Deliverables type">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'reviews'}
            className={`deliverables-hub-tab deliverables-hub-tab--reviews${tab === 'reviews' ? ' deliverables-hub-tab--active' : ''}`}
            onClick={() => setTab('reviews')}
          >
            Review Links
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'deliveries'}
            className={`deliverables-hub-tab deliverables-hub-tab--deliveries${tab === 'deliveries' ? ' deliverables-hub-tab--active' : ''}`}
            onClick={() => setTab('deliveries')}
          >
            Deliveries
          </button>
        </div>

        {/* Body — only the active tab's body actually fetches. The inactive one
            stays mounted so re-tab is instant, but its `active` prop is false. */}
        <div className="deliverables-hub-body">
          {tab === 'reviews' && (
            <DeliverablesPanelBody
              projectId={projectId}
              assets={assets}
              active={open && tab === 'reviews'}
            />
          )}
          {tab === 'deliveries' && (
            <DeliveryPanelBody
              projectId={projectId}
              assets={assets}
              active={open && tab === 'deliveries'}
              pendingCreate={pendingDeliveryCreate}
              onPendingConsumed={onPendingDeliveryConsumed}
            />
          )}
        </div>
      </aside>
    </>
  );
}
