'use client';

import { useEffect, useState } from 'react';
import { AdminsPanel } from '@/components/settings/AdminsPanel';
import { CloudflareOrphansPanel } from '@/components/settings/CloudflareOrphansPanel';
import { TaskCategoriesPanel } from '@/components/settings/TaskCategoriesPanel';
import { GuestPinCard } from '@/components/settings/GuestPinCard';
import { ActiveClientsCard } from '@/components/settings/ActiveClientsCard';
import { SlackUsersCard } from '@/components/settings/SlackUsersCard';
import { ConsoleAlertsCard } from '@/components/settings/ConsoleAlertsCard';
import { LpReleasesCard } from '@/components/settings/LpReleasesCard';
import { EpReleasesCard } from '@/components/settings/EpReleasesCard';
import { EditpanelAccessPanel } from '@/components/settings/EditpanelAccessPanel';
import { ProspectsAccessPanel } from '@/components/settings/ProspectsAccessPanel';
import { PreprodBoardAccessPanel } from '@/components/settings/PreprodBoardAccessPanel';
import { NasIngestPanel } from '@/components/settings/NasIngestPanel';
import { StorageMapCard } from '@/components/settings/StorageMapCard';
import { EpTokensPanel } from '@/components/settings/EpTokensPanel';
import { TranscriptionConfigCard } from '@/components/settings/TranscriptionConfigCard';
import { StorageSettingsClient } from '@/components/settings/StorageSettingsClient';
import { ColdStorageSection } from '@/components/settings/ColdStorageSection';
import { DriveSettingsClient } from '@/components/settings/DriveSettingsClient';

const TABS = [
  { id: 'storage',      label: 'Storage' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'access',       label: 'Access' },
  { id: 'media',        label: 'Media' },
  { id: 'system',       label: 'System' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function isTabId(value: string): value is TabId {
  return TABS.some((t) => t.id === value);
}

function GroupHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="settings-group-heading">
      <h3>{title}</h3>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

const HERO = (
  <div className="storage-settings-hero">
    <div>
      <p className="storage-settings-kicker">Settings</p>
      <h1 className="storage-settings-title">Host settings</h1>
      <p className="storage-settings-copy">
        Manage the LPOS host configuration — storage, integrations, access, and machine-level controls.
      </p>
    </div>
  </div>
);

/**
 * Admin Settings surface. Replaces the former flat stack of ~20 role-gated
 * panels (rendered in add-order) with five grouped tabs. Panels themselves are
 * unchanged — only relocated. The tab is reflected in the URL hash so sections
 * are linkable and survive a refresh (e.g. the B2 cold-storage notification
 * deep-links to /settings#storage).
 *
 * Non-admins only ever had access to local drive allocation, so they see just
 * that — no tab strip.
 */
export function AdminSettings({ role }: { role: string }) {
  const isAdmin = role === 'admin';
  const [tab, setTab] = useState<TabId>('storage');

  useEffect(() => {
    const applyHash = () => {
      const fromHash = window.location.hash.replace('#', '');
      if (isTabId(fromHash)) setTab(fromHash);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  function selectTab(id: TabId) {
    setTab(id);
    // Update the hash without triggering a scroll-to-anchor jump.
    window.history.replaceState(null, '', `#${id}`);
  }

  if (!isAdmin) {
    return (
      <section className="storage-settings-page">
        {HERO}
        <StorageSettingsClient />
      </section>
    );
  }

  return (
    <section className="storage-settings-page">
      {HERO}

      <div className="proj-tabs settings-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`proj-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-tab-panels">
        {tab === 'storage' && (
          <>
            <StorageSettingsClient />
            <StorageMapCard />
            <ColdStorageSection />
          </>
        )}

        {tab === 'integrations' && (
          <>
            <DriveSettingsClient />
            <GroupHeading title="Slack" subtitle="Crash alerts and per-user delivery." />
            <ConsoleAlertsCard />
            <SlackUsersCard />
          </>
        )}

        {tab === 'access' && (
          <>
            <AdminsPanel />
            <EpTokensPanel />
            <GroupHeading title="Feature access" subtitle="Who can see and use each feature." />
            <EditpanelAccessPanel />
            <ProspectsAccessPanel />
            <PreprodBoardAccessPanel />
            <NasIngestPanel />
          </>
        )}

        {tab === 'media' && (
          <>
            <TranscriptionConfigCard />
            <CloudflareOrphansPanel />
            <TaskCategoriesPanel />
          </>
        )}

        {tab === 'system' && (
          <>
            <GroupHeading title="App releases" subtitle="Auto-update distribution for the desktop clients." />
            <LpReleasesCard />
            <EpReleasesCard />
            <GroupHeading title="Operations" />
            <ActiveClientsCard />
            <GuestPinCard />
          </>
        )}
      </div>
    </section>
  );
}
