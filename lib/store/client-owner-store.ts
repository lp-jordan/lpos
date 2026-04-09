import type { ClientOwners } from '@/lib/models/client-owner';
import { getCoreDb } from './core-db';

export class ClientOwnerStore {
  // ── Read ─────────────────────────────────────────────────────────────────

  getAll(): ClientOwners {
    const rows = getCoreDb().prepare('SELECT client_name, user_id FROM client_owners').all() as { client_name: string; user_id: string }[];
    return Object.fromEntries(rows.map((r) => [r.client_name, r.user_id]));
  }

  // ── Write ────────────────────────────────────────────────────────────────

  set(clientName: string, userId: string): void {
    getCoreDb().prepare(
      'INSERT INTO client_owners (client_name, user_id) VALUES (?, ?) ON CONFLICT(client_name) DO UPDATE SET user_id = excluded.user_id',
    ).run(clientName, userId);
  }

  remove(clientName: string): void {
    getCoreDb().prepare('DELETE FROM client_owners WHERE client_name = ?').run(clientName);
  }

  rename(oldName: string, newName: string): void {
    getCoreDb().prepare(
      'UPDATE client_owners SET client_name = ? WHERE client_name = ?',
    ).run(newName, oldName);
  }
}
