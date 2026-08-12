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

  /**
   * The ONE true "rename a client" operation. Converts the client in place
   * across every core-db table that stores the client NAME as a string key,
   * instead of forking a new client (the bug in the old flow, where per-project
   * clientName PATCHes triggered ensureProspectForClient and minted a duplicate
   * prospect while the old client/prospect rows survived).
   *
   * Updated in a single transaction:
   *   - clients.name
   *   - projects.client_name          (ALL projects, incl. archived)
   *   - tasks.client_name
   *   - asset_link_groups.client_name
   *   - delivery_notifications.client_name
   *   - client_owners.client_name     (PK — OR REPLACE guards a stray target key)
   *   - the linked prospect's company  (renames the People/CRM record in place)
   *   - prospects.client_name          (denormalized link on any referencing row)
   *
   * Does NOT touch Google Drive: the folder cache is name-keyed and its rename
   * is an async Drive API call, so the caller re-keys it via renameClientFolder()
   * after this commits.
   *
   * @returns counts + the linked prospectId, or null if no client exists under
   *   oldName. Throws if newName is already taken by a different client.
   */
  rename(oldName: string, newName: string): {
    movedProjects: number;
    movedTasks:    number;
    prospectId:    string | null;
  } | null {
    const db       = getCoreDb();
    const existing = this.getByName(oldName);
    if (!existing) return null;

    const collision = this.getByName(newName);
    if (collision && collision.clientId !== existing.clientId) {
      throw new Error(`A client named "${newName}" already exists.`);
    }

    const now        = new Date().toISOString();
    const prospectId = existing.prospectId;

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE clients SET name = ? WHERE client_id = ?')
        .run(newName, existing.clientId);

      const proj = db.prepare('UPDATE projects SET client_name = ?, updated_at = ? WHERE client_name = ?')
        .run(newName, now, oldName) as { changes: number };

      const tsk = db.prepare('UPDATE tasks SET client_name = ? WHERE client_name = ?')
        .run(newName, oldName) as { changes: number };

      db.prepare('UPDATE asset_link_groups SET client_name = ? WHERE client_name = ?')
        .run(newName, oldName);
      db.prepare('UPDATE delivery_notifications SET client_name = ? WHERE client_name = ?')
        .run(newName, oldName);
      db.prepare('UPDATE OR REPLACE client_owners SET client_name = ? WHERE client_name = ?')
        .run(newName, oldName);

      // Rename the linked People/CRM record IN PLACE — the step the old flow
      // skipped, which is what created the duplicate prospect.
      if (prospectId) {
        db.prepare('UPDATE prospects SET company = ?, updated_at = ? WHERE prospect_id = ?')
          .run(newName, now, prospectId);
      }
      db.prepare('UPDATE prospects SET client_name = ? WHERE client_name = ?')
        .run(newName, oldName);

      db.exec('COMMIT');
      return { movedProjects: proj.changes, movedTasks: tsk.changes, prospectId };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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
