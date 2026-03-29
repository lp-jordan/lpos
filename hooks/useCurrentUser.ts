'use client';

import { useEffect, useState } from 'react';
import type { UserSummary } from '@/lib/models/user';

export function useCurrentUser(): UserSummary | null {
  const [user, setUser] = useState<UserSummary | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json() as Promise<{ user: UserSummary | null }>)
      .then(({ user }) => { if (user) setUser(user); })
      .catch(() => {});
  }, []);

  return user;
}
