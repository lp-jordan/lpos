'use client';

import { useCallback, useEffect, useState } from 'react';

interface EnabledVolumeHealth {
  rootPath: string;
  label: string;
  mounted: boolean;
  writable: boolean;
  reason: string | null;
  priority: number;
}

interface StorageMountStatus {
  ok: boolean;
  activeLabel: string | null;
  problems: EnabledVolumeHealth[];
  checkedAt: string;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Persistent red banner shown when an enabled storage drive (e.g. the NAS-backed
 * "LeaderPass Main") is not mounted or not writable. This catches the case where
 * the host machine was reset and silently lost its NAS connection — uploads and
 * media resolution fail app-wide until the drive is remounted. Renders nothing
 * while all enabled drives are healthy.
 */
export function DriveMountBanner() {
  const [problems, setProblems] = useState<EnabledVolumeHealth[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/storage/status', { cache: 'no-store' });
      if (!res.ok) return; // network/auth blip — keep last known state, retry next tick
      const status = (await res.json()) as StorageMountStatus;
      setProblems(Array.isArray(status.problems) ? status.problems : []);
    } catch {
      // Fetch failed — don't flip the banner on a transient error.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (problems.length === 0) return null;

  const names = problems.map((p) => p.label);
  const label =
    names.length === 1
      ? `"${names[0]}"`
      : `${names.slice(0, -1).map((n) => `"${n}"`).join(', ')} and "${names[names.length - 1]}"`;
  const driveWord = names.length === 1 ? 'drive' : 'drives';
  const notWritableOnly = problems.every((p) => p.mounted && !p.writable);
  const stateWord = notWritableOnly ? 'not writable' : 'not connected';

  return (
    <div className="drive-banner" role="alert" aria-live="assertive">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="drive-banner-icon"
      >
        <path d="M22 12H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        <line x1="6" y1="16" x2="6.01" y2="16" />
        <line x1="10" y1="16" x2="10.01" y2="16" />
      </svg>
      <span>
        Storage {driveWord} {label} {stateWord} — the host may have lost its NAS mount.{' '}
        <strong>Uploads and media will fail</strong> until it is reconnected.
      </span>
    </div>
  );
}
