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
import { SettingsTabs, type SettingsSection } from '@/components/settings/SettingsTabs';

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
 * unchanged — only relocated.
 *
 * This is a SERVER component: it renders every panel (including server-only ones
 * like GuestPinCard / StorageMapCard that import node:crypto / node:process) and
 * hands the per-tab content to the client `SettingsTabs` shell as ReactNodes.
 * Keeping the container server-side is what prevents those node: modules from
 * being pulled into the client bundle (which broke the build when this was a
 * client component).
 *
 * Non-admins only ever had access to local drive allocation, so they see just
 * that — no tab strip.
 */
export function AdminSettings({ role }: { role: string }) {
  if (role !== 'admin') {
    return (
      <section className="storage-settings-page">
        {HERO}
        <StorageSettingsClient />
      </section>
    );
  }

  const sections: SettingsSection[] = [
    {
      id: 'storage',
      label: 'Storage',
      content: (
        <>
          <StorageSettingsClient />
          <StorageMapCard />
          <ColdStorageSection />
        </>
      ),
    },
    {
      id: 'integrations',
      label: 'Integrations',
      content: (
        <>
          <DriveSettingsClient />
          <GroupHeading title="Slack" subtitle="Crash alerts and per-user delivery." />
          <ConsoleAlertsCard />
          <SlackUsersCard />
        </>
      ),
    },
    {
      id: 'access',
      label: 'Access',
      content: (
        <>
          <AdminsPanel />
          <EpTokensPanel />
          <GroupHeading title="Feature access" subtitle="Who can see and use each feature." />
          <EditpanelAccessPanel />
          <ProspectsAccessPanel />
          <PreprodBoardAccessPanel />
          <NasIngestPanel />
        </>
      ),
    },
    {
      id: 'media',
      label: 'Media',
      content: (
        <>
          <TranscriptionConfigCard />
          <CloudflareOrphansPanel />
          <TaskCategoriesPanel />
        </>
      ),
    },
    {
      id: 'system',
      label: 'System',
      content: (
        <>
          <GroupHeading title="App releases" subtitle="Auto-update distribution for the desktop clients." />
          <LpReleasesCard />
          <EpReleasesCard />
          <GroupHeading title="Operations" />
          <ActiveClientsCard />
          <GuestPinCard />
        </>
      ),
    },
  ];

  return (
    <section className="storage-settings-page">
      {HERO}
      <SettingsTabs sections={sections} />
    </section>
  );
}
