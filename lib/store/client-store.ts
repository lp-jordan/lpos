import { randomUUID } from 'node:crypto';
import { getCoreDb } from './core-db';

export interface Client {
  clientId:   string;
  name:       string;
  prospectId: string | null;
  isParent:   boolean;
  createdBy:  string;
  createdAt:  string;
}

function rowToClient(row: Record<string, unknown>): Client {
  return {
    clientId:   row.client_id   as string,
    name:       row.name        as string,
    prospectId: row.prospect_id as string | null,
    isParent:   Boolean(row.is_parent),
    createdBy:  row.created_by  as string,
    createdAt:  row.created_at  as string,
  };
}

export class ClientStore {
  upsertForProspect(prospectId: string, name: string, createdBy: string): Client {
    const existing = this.getByProspectId(prospectId);
    if (existing) {
      getCoreDb()
        .prepare('UPDATE clients SET name = ? WHERE prospect_id = ?')
        .run(name, prospectId);
      return { ...existing, name };
    }
    return this.createClient(name, prospectId, createdBy);
  }

  createClient(name: string, prospectId: string | null, createdBy: string): Client {
    const id  = randomUUID();
    const now = new Date().toISOString();
    getCoreDb()
      .prepare(`INSERT INTO clients (client_id, name, prospect_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, prospectId, createdBy, now);
    return { clientId: id, name, prospectId, isParent: false, createdBy, createdAt: now };
  }

  getById(clientId: string): Client | null {
    const row = getCoreDb()
      .prepare(`SELECT * FROM clients WHERE client_id = ?`)
      .get(clientId) as Record<string, unknown> | undefined;
    return row ? rowToClient(row) : null;
  }

  getByProspectId(prospectId: string): Client | null {
    const row = getCoreDb()
      .prepare(`SELECT * FROM clients WHERE prospect_id = ?`)
      .get(prospectId) as Record<string, unknown> | undefined;
    return row ? rowToClient(row) : null;
  }

  getByName(name: string): Client | null {
    const row = getCoreDb()
      .prepare(`SELECT * FROM clients WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    return row ? rowToClient(row) : null;
  }

  deleteByProspectId(prospectId: string): boolean {
    const result = getCoreDb()
      .prepare('DELETE FROM clients WHERE prospect_id = ?')
      .run(prospectId) as { changes: number };
    return result.changes > 0;
  }

  deleteByName(name: string): boolean {
    const result = getCoreDb()
      .prepare('DELETE FROM clients WHERE name = ?')
      .run(name) as { changes: number };
    return result.changes > 0;
  }

  getAll(): Client[] {
    const rows = getCoreDb()
      .prepare(`SELECT * FROM clients ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToClient);
  }

  /** Mark a client as a parent org (container). Idempotent. */
  setAsParent(clientId: string): void {
    getCoreDb()
      .prepare(`UPDATE clients SET is_parent = 1 WHERE client_id = ?`)
      .run(clientId);
  }

  /** Returns the set of client names that are parent orgs. Used by the
   *  People page to group child prospects under their parent row. */
  getParentClientNames(): Set<string> {
    const rows = getCoreDb()
      .prepare(`SELECT name FROM clients WHERE is_parent = 1`)
      .all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }
}
