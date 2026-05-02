import { randomUUID } from 'node:crypto';
import { getCoreDb } from './core-db';

export interface Client {
  clientId:   string;
  name:       string;
  prospectId: string | null;
  createdBy:  string;
  createdAt:  string;
}

function rowToClient(row: Record<string, unknown>): Client {
  return {
    clientId:   row.client_id as string,
    name:       row.name      as string,
    prospectId: row.prospect_id as string | null,
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
    return { clientId: id, name, prospectId, createdBy, createdAt: now };
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
}
