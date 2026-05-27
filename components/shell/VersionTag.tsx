'use client';

import { useState } from 'react';
import type { AppVersion } from '@/lib/version';

/**
 * Tiny build/version chip in the top-right corner. Click to copy the full
 * SHA — useful when we need to `git checkout` to a build a user reported a
 * bug against. Auto-advances every commit (count) and every push (SHA).
 */
export function VersionTag({ version }: { version: AppVersion }) {
  const [copied, setCopied] = useState(false);

  const title = [
    `commit ${version.sha}`,
    `branch ${version.branch}`,
    version.date && `date ${version.date}`,
    version.dirty && 'working tree had uncommitted changes at server start',
    '',
    'click to copy full SHA',
  ]
    .filter(Boolean)
    .join('\n');

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(version.sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <button
      type="button"
      className="version-tag"
      onClick={onClick}
      title={title}
      aria-label={`Build ${version.display}. Click to copy commit SHA.`}
      data-guest-ok
    >
      {copied ? 'copied' : version.display}
    </button>
  );
}
