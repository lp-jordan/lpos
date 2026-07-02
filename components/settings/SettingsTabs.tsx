'use client';

import { useEffect, useState, type ReactNode } from 'react';

export interface SettingsSection {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Client tab-shell for the admin Settings page. It receives already-rendered
 * panel content as props (server components rendered on the server, passed in as
 * ReactNodes) so that server-only panels — GuestPinCard, StorageMapCard, which
 * import node:crypto / node:process — never cross into the client bundle. The
 * shell only owns the interactive bits: which tab is active + URL-hash sync.
 *
 * Only the active section is placed in the tree, so a tab's client panels don't
 * mount (and don't fire their fetches) until that tab is opened.
 */
export function SettingsTabs({ sections }: { sections: SettingsSection[] }) {
  const ids = sections.map((s) => s.id);
  const [active, setActive] = useState<string>(sections[0]?.id ?? '');

  useEffect(() => {
    const applyHash = () => {
      const fromHash = window.location.hash.replace('#', '');
      if (ids.includes(fromHash)) setActive(fromHash);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTab(id: string) {
    setActive(id);
    // Update the hash without triggering a scroll-to-anchor jump.
    window.history.replaceState(null, '', `#${id}`);
  }

  const current = sections.find((s) => s.id === active) ?? sections[0];

  return (
    <>
      <div className="proj-tabs settings-tabs" role="tablist">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === s.id}
            className={`proj-tab${active === s.id ? ' active' : ''}`}
            onClick={() => selectTab(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="settings-tab-panels">{current?.content}</div>
    </>
  );
}
