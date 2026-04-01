'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';
import { RestartButton } from './RestartButton';

const ADMIN_EMAIL = 'jordan@leaderpass.com';

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || 'U';
}

export function UserMenu({ user }: { user: UserSummary }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        type="button"
        className="user-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Open user menu for ${user.name}`}
        data-guest-ok
      >
        {user.avatarUrl
          ? <img src={user.avatarUrl} alt="" className="user-menu-avatar-image" />
          : <span className="user-menu-avatar-fallback">{initialsFor(user.name)}</span>}
      </button>

      {open && (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-header">
            <div className="user-menu-name">{user.name}</div>
            <div className="user-menu-email">{user.email}</div>
          </div>
          <Link href="/dashboard" className="user-menu-link" role="menuitem" onClick={() => setOpen(false)}>
            My Dashboard
          </Link>
          {user.email === ADMIN_EMAIL && <RestartButton />}
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="user-menu-link user-menu-link--button" role="menuitem" data-guest-ok>
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
