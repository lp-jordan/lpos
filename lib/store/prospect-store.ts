import { randomUUID } from 'node:crypto';
import type {
  Prospect,
  ProspectContact,
  ProspectStatus,
  ProspectStatusHistory,
  ProspectUpdate,
} from '@/lib/models/prospect';
import { getCoreDb, withTransaction } from './core-db';

// ── Row types ─────────────────────────────────────────────────────────────────

interface ProspectRow {
  prospect_id:               string;
  company:                   string;
  website:                   string | null;
  industry:                  string | null;
  source:                    string | null;
  status:                    string;
  archived:                  number;
  created_by:                string;
  created_at:                string;
  updated_at:                string;
  promoted_at:               string | null;
  client_name:               string | null;
  account_model:             string | null;
  revenue_type:              string | null;
  one_time_lp_revenue:       number | null;
  monthly_lp_revenue:        number | null;
  monthly_lp_tech_revenue:   number | null;
  estimated_first_year_value: number | null;
  expected_start_month:      string | null;
  expansion_potential:       string | null;
  owner:                     string | null;
  start_month:               string | null;
  recurring_billing_status:  string | null;
  renewal_date:              string | null;
  first_recurring_bill_date: string | null;
  active_services:           string | null;
  next_film_date:            string | null;
}

interface ProspectUserRow {
  prospect_id: string;
  user_id:     string;
}

interface ContactRow {
  contact_id:  string;
  prospect_id: string;
  name:        string;
  role:        string | null;
  email:       string | null;
  phone:       string | null;
  linkedin:    string | null;
  created_at:  string;
}

interface UpdateRow {
  update_id:   string;
  prospect_id: string;
  author_id:   string;
  body:        string;
  created_at:  string;
  edited_at:   string | null;
}

interface StatusHistoryRow {
  history_id:  string;
  prospect_id: string;
  from_status: string | null;
  to_status:   string;
  changed_by:  string;
  changed_at:  string;
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function rowToProspect(row: ProspectRow, assignedTo: string[]): Prospect {
  return {
    prospectId:              row.prospect_id,
    company:                 row.company,
    website:                 row.website,
    industry:                row.industry,
    source:                  row.source,
    status:                  row.status as ProspectStatus,
    archived:                row.archived === 1,
    createdBy:               row.created_by,
    createdAt:               row.created_at,
    updatedAt:               row.updated_at,
    promotedAt:              row.promoted_at,
    clientName:              row.client_name,
    assignedTo,
    accountModel:            row.account_model,
    revenueType:             row.revenue_type,
    oneTimeLpRevenue:        row.one_time_lp_revenue,
    monthlyLpRevenue:        row.monthly_lp_revenue,
    monthlyLpTechRevenue:    row.monthly_lp_tech_revenue,
    estimatedFirstYearValue: row.estimated_first_year_value,
    expectedStartMonth:      row.expected_start_month,
    expansionPotential:      row.expansion_potential,
    owner:                   row.owner,
    startMonth:              row.start_month,
    recurringBillingStatus:  row.recurring_billing_status,
    renewalDate:             row.renewal_date,
    firstRecurringBillDate:  row.first_recurring_bill_date,
    activeServices:          row.active_services,
    nextFilmDate:            row.next_film_date,
  };
}

function rowToContact(row: ContactRow): ProspectContact {
  return {
    contactId:  row.contact_id,
    prospectId: row.prospect_id,
    name:       row.name,
    role:       row.role,
    email:      row.email,
    phone:      row.phone,
    linkedin:   row.linkedin,
    createdAt:  row.created_at,
  };
}

function rowToUpdate(row: UpdateRow): ProspectUpdate {
  return {
    updateId:   row.update_id,
    prospectId: row.prospect_id,
    authorId:   row.author_id,
    body:       row.body,
    createdAt:  row.created_at,
    editedAt:   row.edited_at,
  };
}

function rowToStatusHistory(row: StatusHistoryRow): ProspectStatusHistory {
  return {
    historyId:  row.history_id,
    prospectId: row.prospect_id,
    fromStatus: (row.from_status as ProspectStatus) ?? null,
    toStatus:   row.to_status as ProspectStatus,
    changedBy:  row.changed_by,
    changedAt:  row.changed_at,
  };
}

function buildAssigneeMap(rows: ProspectUserRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const arr = map.get(row.prospect_id) ?? [];
    arr.push(row.user_id);
    map.set(row.prospect_id, arr);
  }
  return map;
}

function getAssigneesForProspect(prospectId: string): string[] {
  return (
    getCoreDb()
      .prepare('SELECT user_id FROM prospect_users WHERE prospect_id = ?')
      .all(prospectId) as { user_id: string }[]
  ).map((r) => r.user_id);
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class ProspectStore {
  // ── Read ───────────────────────────────────────────────────────────────────

  getAll(opts: { includeArchived?: boolean } = {}): Prospect[] {
    const db = getCoreDb();
    const rows = opts.includeArchived
      ? (db.prepare('SELECT * FROM prospects ORDER BY updated_at DESC').all() as ProspectRow[])
      : (db.prepare('SELECT * FROM prospects WHERE archived = 0 ORDER BY updated_at DESC').all() as ProspectRow[]);
    if (rows.length === 0) return [];
    const assigneeMap = buildAssigneeMap(
      db.prepare('SELECT prospect_id, user_id FROM prospect_users').all() as ProspectUserRow[],
    );
    return rows.map((row) => rowToProspect(row, assigneeMap.get(row.prospect_id) ?? []));
  }

  getForUser(userId: string, opts: { includeArchived?: boolean } = {}): Prospect[] {
    const db = getCoreDb();
    const archiveClause = opts.includeArchived ? '' : 'AND p.archived = 0';
    const rows = db.prepare(`
      SELECT DISTINCT p.* FROM prospects p
      LEFT JOIN prospect_users pu ON p.prospect_id = pu.prospect_id
      WHERE (p.created_by = ? OR pu.user_id = ?) ${archiveClause}
      ORDER BY p.updated_at DESC
    `).all(userId, userId) as ProspectRow[];
    return rows.map((row) => rowToProspect(row, getAssigneesForProspect(row.prospect_id)));
  }

  getById(prospectId: string): Prospect | null {
    const row = getCoreDb()
      .prepare('SELECT * FROM prospects WHERE prospect_id = ?')
      .get(prospectId) as ProspectRow | undefined;
    if (!row) return null;
    return rowToProspect(row, getAssigneesForProspect(prospectId));
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  create(input: {
    company:      string;
    website?:     string | null;
    industry?:    string | null;
    source?:      string | null;
    accountModel?: string | null;
    createdBy:    string;
    assignedTo?:  string[];
  }): Prospect {
    const db  = getCoreDb();
    const now = new Date().toISOString();
    const prospect: Prospect = {
      prospectId:              randomUUID(),
      company:                 input.company.trim(),
      website:                 input.website ?? null,
      industry:                input.industry ?? null,
      source:                  input.source ?? null,
      status:                  'prospect',
      archived:                false,
      createdBy:               input.createdBy,
      createdAt:               now,
      updatedAt:               now,
      promotedAt:              null,
      clientName:              null,
      assignedTo:              input.assignedTo?.length ? input.assignedTo : [input.createdBy],
      accountModel:            input.accountModel ?? null,
      revenueType:             null,
      oneTimeLpRevenue:        null,
      monthlyLpRevenue:        null,
      monthlyLpTechRevenue:    null,
      estimatedFirstYearValue: null,
      expectedStartMonth:      null,
      expansionPotential:      null,
      owner:                   null,
      startMonth:              null,
      recurringBillingStatus:  null,
      renewalDate:             null,
      firstRecurringBillDate:  null,
      activeServices:          null,
      nextFilmDate:            null,
    };

    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO prospects (
          prospect_id, company, website, industry, source, status, archived,
          created_by, created_at, updated_at, promoted_at, client_name,
          account_model, revenue_type, one_time_lp_revenue, monthly_lp_revenue,
          monthly_lp_tech_revenue, estimated_first_year_value, expected_start_month,
          expansion_potential, owner, start_month, recurring_billing_status,
          renewal_date, first_recurring_bill_date, active_services, next_film_date
        ) VALUES (
          ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        prospect.prospectId, prospect.company, prospect.website, prospect.industry,
        prospect.source, prospect.status, prospect.createdBy, prospect.createdAt, prospect.updatedAt,
        prospect.accountModel, prospect.revenueType, prospect.oneTimeLpRevenue,
        prospect.monthlyLpRevenue, prospect.monthlyLpTechRevenue, prospect.estimatedFirstYearValue,
        prospect.expectedStartMonth, prospect.expansionPotential, prospect.owner,
        prospect.startMonth, prospect.recurringBillingStatus, prospect.renewalDate,
        prospect.firstRecurringBillDate, prospect.activeServices, prospect.nextFilmDate,
      );

      for (const userId of prospect.assignedTo) {
        db.prepare('INSERT INTO prospect_users (prospect_id, user_id, assigned_at) VALUES (?, ?, ?)')
          .run(prospect.prospectId, userId, now);
      }

      db.prepare(`
        INSERT INTO prospect_status_history (history_id, prospect_id, from_status, to_status, changed_by, changed_at)
        VALUES (?, ?, NULL, ?, ?, ?)
      `).run(randomUUID(), prospect.prospectId, prospect.status, prospect.createdBy, now);
    });

    return prospect;
  }

  update(
    prospectId: string,
    patch: Partial<Omit<Prospect, 'prospectId' | 'createdBy' | 'createdAt' | 'archived' | 'assignedTo' | 'promotedAt' | 'clientName'>>,
    changedBy: string,
  ): Prospect | null {
    const db       = getCoreDb();
    const existing = this.getById(prospectId);
    if (!existing) return null;

    const now  = new Date().toISOString();
    const next: Prospect = { ...existing, ...patch, updatedAt: now };
    const statusChanged = patch.status !== undefined && patch.status !== existing.status;

    withTransaction(db, () => {
      db.prepare(`
        UPDATE prospects SET
          company = ?, website = ?, industry = ?, source = ?, status = ?,
          account_model = ?, revenue_type = ?,
          one_time_lp_revenue = ?, monthly_lp_revenue = ?, monthly_lp_tech_revenue = ?,
          estimated_first_year_value = ?, expected_start_month = ?, expansion_potential = ?,
          owner = ?, start_month = ?, recurring_billing_status = ?,
          renewal_date = ?, first_recurring_bill_date = ?, active_services = ?, next_film_date = ?,
          updated_at = ?
        WHERE prospect_id = ?
      `).run(
        next.company, next.website, next.industry, next.source, next.status,
        next.accountModel, next.revenueType,
        next.oneTimeLpRevenue, next.monthlyLpRevenue, next.monthlyLpTechRevenue,
        next.estimatedFirstYearValue, next.expectedStartMonth, next.expansionPotential,
        next.owner, next.startMonth, next.recurringBillingStatus,
        next.renewalDate, next.firstRecurringBillDate, next.activeServices, next.nextFilmDate,
        now, prospectId,
      );

      if (statusChanged) {
        db.prepare(`
          INSERT INTO prospect_status_history (history_id, prospect_id, from_status, to_status, changed_by, changed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), prospectId, existing.status, next.status, changedBy, now);
      }
    });

    return { ...next, assignedTo: existing.assignedTo };
  }

  archive(prospectId: string): boolean {
    const now    = new Date().toISOString();
    const result = getCoreDb()
      .prepare('UPDATE prospects SET archived = 1, updated_at = ? WHERE prospect_id = ?')
      .run(now, prospectId) as { changes: number };
    return result.changes > 0;
  }

  unarchive(prospectId: string): boolean {
    const now    = new Date().toISOString();
    const result = getCoreDb()
      .prepare('UPDATE prospects SET archived = 0, updated_at = ? WHERE prospect_id = ?')
      .run(now, prospectId) as { changes: number };
    return result.changes > 0;
  }

  promote(prospectId: string, clientName: string, actorId: string): Prospect | null {
    const existing = this.getById(prospectId);
    if (!existing || existing.status === 'active') return null;
    const now = new Date().toISOString();

    withTransaction(getCoreDb(), () => {
      getCoreDb().prepare(`
        UPDATE prospects
        SET status = 'active', promoted_at = ?, client_name = ?, updated_at = ?
        WHERE prospect_id = ?
      `).run(now, clientName, now, prospectId);

      getCoreDb().prepare(`
        INSERT INTO prospect_status_history (history_id, prospect_id, from_status, to_status, changed_by, changed_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(randomUUID(), prospectId, existing.status, actorId, now);
    });

    return this.getById(prospectId);
  }

  deleteProspect(prospectId: string): boolean {
    const db = getCoreDb();
    withTransaction(db, () => {
      db.prepare('DELETE FROM prospect_users WHERE prospect_id = ?').run(prospectId);
      db.prepare('DELETE FROM prospect_contacts WHERE prospect_id = ?').run(prospectId);
      db.prepare('DELETE FROM prospect_updates WHERE prospect_id = ?').run(prospectId);
      db.prepare('DELETE FROM prospect_status_history WHERE prospect_id = ?').run(prospectId);
      db.prepare('DELETE FROM prospect_notifications WHERE prospect_id = ?').run(prospectId);
      db.prepare('DELETE FROM prospects WHERE prospect_id = ?').run(prospectId);
    });
    return true;
  }

  getLastUpdatePerProspect(): Record<string, string> {
    const rows = getCoreDb().prepare(`
      SELECT prospect_id, MAX(created_at) AS last_update
      FROM prospect_updates
      GROUP BY prospect_id
    `).all() as { prospect_id: string; last_update: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.prospect_id] = row.last_update;
    return result;
  }

  getLastUpdateBodies(): Record<string, string> {
    const rows = getCoreDb().prepare(`
      SELECT u.prospect_id, u.body
      FROM prospect_updates u
      INNER JOIN (
        SELECT prospect_id, MAX(created_at) AS max_at
        FROM prospect_updates
        GROUP BY prospect_id
      ) latest ON u.prospect_id = latest.prospect_id AND u.created_at = latest.max_at
    `).all() as { prospect_id: string; body: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.prospect_id] = row.body;
    return result;
  }

  // ── User assignment ────────────────────────────────────────────────────────

  addUser(prospectId: string, userId: string): void {
    const now = new Date().toISOString();
    getCoreDb()
      .prepare('INSERT OR IGNORE INTO prospect_users (prospect_id, user_id, assigned_at) VALUES (?, ?, ?)')
      .run(prospectId, userId, now);
    getCoreDb()
      .prepare('UPDATE prospects SET updated_at = ? WHERE prospect_id = ?')
      .run(now, prospectId);
  }

  removeUser(prospectId: string, userId: string): void {
    getCoreDb()
      .prepare('DELETE FROM prospect_users WHERE prospect_id = ? AND user_id = ?')
      .run(prospectId, userId);
    getCoreDb()
      .prepare('UPDATE prospects SET updated_at = ? WHERE prospect_id = ?')
      .run(new Date().toISOString(), prospectId);
  }

  // ── Contacts ───────────────────────────────────────────────────────────────

  getContacts(prospectId: string): ProspectContact[] {
    return (
      getCoreDb()
        .prepare('SELECT * FROM prospect_contacts WHERE prospect_id = ? ORDER BY created_at ASC')
        .all(prospectId) as ContactRow[]
    ).map(rowToContact);
  }

  addContact(
    prospectId: string,
    input: { name: string; role?: string | null; email?: string | null; phone?: string | null; linkedin?: string | null },
  ): ProspectContact {
    const now     = new Date().toISOString();
    const contact: ProspectContact = {
      contactId:  randomUUID(),
      prospectId,
      name:       input.name.trim(),
      role:       input.role ?? null,
      email:      input.email ?? null,
      phone:      input.phone ?? null,
      linkedin:   input.linkedin ?? null,
      createdAt:  now,
    };
    getCoreDb().prepare(`
      INSERT INTO prospect_contacts (contact_id, prospect_id, name, role, email, phone, linkedin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contact.contactId, contact.prospectId, contact.name, contact.role, contact.email, contact.phone, contact.linkedin, contact.createdAt);
    return contact;
  }

  updateContact(
    contactId: string,
    patch: Partial<Pick<ProspectContact, 'name' | 'role' | 'email' | 'phone' | 'linkedin'>>,
  ): ProspectContact | null {
    const row = getCoreDb()
      .prepare('SELECT * FROM prospect_contacts WHERE contact_id = ?')
      .get(contactId) as ContactRow | undefined;
    if (!row) return null;
    const next = { ...rowToContact(row), ...patch };
    getCoreDb().prepare(`
      UPDATE prospect_contacts SET name = ?, role = ?, email = ?, phone = ?, linkedin = ?
      WHERE contact_id = ?
    `).run(next.name, next.role, next.email, next.phone, next.linkedin, contactId);
    return next;
  }

  deleteContact(contactId: string): boolean {
    const result = getCoreDb()
      .prepare('DELETE FROM prospect_contacts WHERE contact_id = ?')
      .run(contactId) as { changes: number };
    return result.changes > 0;
  }

  // ── Updates log ────────────────────────────────────────────────────────────

  getUpdates(prospectId: string): ProspectUpdate[] {
    return (
      getCoreDb()
        .prepare('SELECT * FROM prospect_updates WHERE prospect_id = ? ORDER BY created_at DESC')
        .all(prospectId) as UpdateRow[]
    ).map(rowToUpdate);
  }

  addUpdate(prospectId: string, authorId: string, body: string): ProspectUpdate {
    const now    = new Date().toISOString();
    const update: ProspectUpdate = {
      updateId:   randomUUID(),
      prospectId,
      authorId,
      body:       body.trim(),
      createdAt:  now,
      editedAt:   null,
    };
    getCoreDb().prepare(`
      INSERT INTO prospect_updates (update_id, prospect_id, author_id, body, created_at, edited_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(update.updateId, update.prospectId, update.authorId, update.body, update.createdAt);
    getCoreDb()
      .prepare('UPDATE prospects SET updated_at = ? WHERE prospect_id = ?')
      .run(now, prospectId);
    return update;
  }

  editUpdate(updateId: string, body: string): ProspectUpdate | null {
    const now = new Date().toISOString();
    const result = getCoreDb()
      .prepare('UPDATE prospect_updates SET body = ?, edited_at = ? WHERE update_id = ?')
      .run(body.trim(), now, updateId) as { changes: number };
    if (result.changes === 0) return null;
    return getCoreDb()
      .prepare('SELECT * FROM prospect_updates WHERE update_id = ?')
      .get(updateId) as ProspectUpdate;
  }

  deleteUpdate(updateId: string): boolean {
    const result = getCoreDb()
      .prepare('DELETE FROM prospect_updates WHERE update_id = ?')
      .run(updateId) as { changes: number };
    return result.changes > 0;
  }

  // ── Status history ─────────────────────────────────────────────────────────

  getStatusHistory(prospectId: string): ProspectStatusHistory[] {
    return (
      getCoreDb()
        .prepare('SELECT * FROM prospect_status_history WHERE prospect_id = ? ORDER BY changed_at DESC')
        .all(prospectId) as StatusHistoryRow[]
    ).map(rowToStatusHistory);
  }
}
