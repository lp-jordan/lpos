'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ClientOwners } from '@/lib/models/client-owner';
import type { UserSummary } from '@/lib/models/user';

export interface UseClientOwnersResult {
  owners: ClientOwners;
  users: UserSummary[];
  assignOwner: (clientName: string, userId: string) => Promise<void>;
  removeOwner: (clientName: string) => Promise<void>;
  renameClient: (oldName: string, newName: string) => Promise<void>;
}

export function useClientOwners(): UseClientOwnersResult {
  const [owners, setOwners] = useState<ClientOwners>({});
  const [users, setUsers] = useState<UserSummary[]>([]);

  useEffect(() => {
    fetch('/api/client-owners')
      .then((r) => r.json() as Promise<{ owners: ClientOwners }>)
      .then(({ owners: o }) => setOwners(o))
      .catch(() => {});

    fetch('/api/users')
      .then((r) => r.json() as Promise<{ users: UserSummary[] }>)
      .then(({ users: u }) => setUsers(u))
      .catch(() => {});
  }, []);

  const assignOwner = useCallback(async (clientName: string, userId: string) => {
    await fetch(`/api/client-owners/${encodeURIComponent(clientName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    setOwners((prev) => ({ ...prev, [clientName]: userId }));
  }, []);

  const removeOwner = useCallback(async (clientName: string) => {
    await fetch(`/api/client-owners/${encodeURIComponent(clientName)}`, {
      method: 'DELETE',
    });
    setOwners((prev) => {
      const next = { ...prev };
      delete next[clientName];
      return next;
    });
  }, []);

  const renameClient = useCallback(async (oldName: string, newName: string) => {
    const userId = owners[oldName];
    if (!userId) return;

    // Optimistic local re-key
    setOwners((prev) => {
      const next = { ...prev };
      next[newName] = userId;
      delete next[oldName];
      return next;
    });

    // Server re-key
    await fetch(`/api/client-owners/${encodeURIComponent(newName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    await fetch(`/api/client-owners/${encodeURIComponent(oldName)}`, {
      method: 'DELETE',
    });
  }, [owners]);

  return { owners, users, assignOwner, removeOwner, renameClient };
}
