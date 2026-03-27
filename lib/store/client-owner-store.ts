import fs from 'node:fs';
import path from 'node:path';
import type { ClientOwners } from '@/lib/models/client-owner';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const OWNERS_FILE = path.join(DATA_DIR, 'client-owners.json');

export class ClientOwnerStore {
  private owners: ClientOwners = {};

  constructor() {
    this.load();
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(OWNERS_FILE)) {
        this.owners = JSON.parse(fs.readFileSync(OWNERS_FILE, 'utf8')) as ClientOwners;
      }
    } catch {
      this.owners = {};
    }
  }

  private persist() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OWNERS_FILE, JSON.stringify(this.owners, null, 2));
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  getAll(): ClientOwners {
    return { ...this.owners };
  }

  // ── Write ────────────────────────────────────────────────────────────────

  set(clientName: string, userId: string): void {
    this.owners[clientName] = userId;
    this.persist();
  }

  remove(clientName: string): void {
    delete this.owners[clientName];
    this.persist();
  }

  /**
   * Re-keys the ownership entry when a client is renamed.
   * If the old name had no owner this is a no-op.
   */
  rename(oldName: string, newName: string): void {
    if (!(oldName in this.owners)) return;
    this.owners[newName] = this.owners[oldName];
    delete this.owners[oldName];
    this.persist();
  }
}
