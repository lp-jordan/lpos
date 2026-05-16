import fs from 'node:fs';
import path from 'node:path';
import { randomUUID as randomUUIDStr } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'lpos-core.sqlite');

declare global {
  // eslint-disable-next-line no-var
  var __lpos_core_db: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA busy_timeout = 5000`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      google_sub    TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL,
      name          TEXT NOT NULL,
      avatar_url    TEXT,
      created_at    TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
    CREATE INDEX IF NOT EXISTS idx_users_email      ON users(email);

    CREATE TABLE IF NOT EXISTS projects (
      project_id  TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      client_name TEXT NOT NULL,
      phase       TEXT NOT NULL DEFAULT 'pre_production',
      sub_phase   TEXT NOT NULL DEFAULT 'discovery',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_projects_client   ON projects(client_name);
    CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id      TEXT PRIMARY KEY,
      description  TEXT NOT NULL,
      client_name  TEXT NOT NULL DEFAULT 'General',
      task_type    TEXT NOT NULL DEFAULT 'editing',
      category     TEXT,
      priority     TEXT NOT NULL DEFAULT 'medium',
      status       TEXT NOT NULL DEFAULT 'not_started',
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_client    ON tasks(client_name);
    CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
    -- idx_tasks_task_type is created by the v8 migration block after task_type is
    -- added to the column set (pre-F1 DBs don't have that column yet at this point).

    CREATE TABLE IF NOT EXISTS task_assignees (
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (task_id, user_id),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);

    CREATE TABLE IF NOT EXISTS wishes (
      wish_id           TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT,
      submitted_by      TEXT NOT NULL,
      submitted_by_name TEXT NOT NULL,
      completed         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      completed_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wishes_submitted_by ON wishes(submitted_by);
    CREATE INDEX IF NOT EXISTS idx_wishes_completed    ON wishes(completed);

    CREATE TABLE IF NOT EXISTS client_owners (
      client_name TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS share_assets (
      project_id TEXT NOT NULL,
      share_id   TEXT NOT NULL,
      file_ids   TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (project_id, share_id)
    );

    CREATE TABLE IF NOT EXISTS asset_share_links (
      project_id TEXT NOT NULL,
      asset_id   TEXT NOT NULL,
      share_id   TEXT NOT NULL,
      share_url  TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, share_id)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_share_links_asset ON asset_share_links(project_id, asset_id);

    -- Phase E: unified Deliverables store. Replaces the fragmented
    -- share_assets + asset_share_links pair. A deliverable is one named,
    -- project-scoped Frame.io share that points at one or more assets;
    -- each asset is tracked by its Frame.io stack_id (preferred — auto-resolves
    -- to head_version) or fallback file_id (when no stack exists yet).
    CREATE TABLE IF NOT EXISTS deliverables (
      deliverable_id   TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      name             TEXT NOT NULL,
      frameio_share_id TEXT NOT NULL,
      short_url        TEXT NOT NULL,
      expires_at       TEXT,
      settings_json    TEXT NOT NULL DEFAULT '{}',
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS deliverable_assets (
      deliverable_id   TEXT NOT NULL REFERENCES deliverables(deliverable_id) ON DELETE CASCADE,
      asset_id         TEXT NOT NULL,
      frameio_stack_id TEXT,
      frameio_file_id  TEXT,
      added_at         TEXT NOT NULL,
      PRIMARY KEY (deliverable_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS idx_deliverable_assets_asset ON deliverable_assets(asset_id);

    CREATE TABLE IF NOT EXISTS task_comments (
      comment_id TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      author_id  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task   ON task_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_author ON task_comments(author_id);

    CREATE TABLE IF NOT EXISTS task_categories (
      category_id TEXT PRIMARY KEY,
      label       TEXT NOT NULL UNIQUE,
      sort_order  INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_categories_sort ON task_categories(sort_order);

    CREATE TABLE IF NOT EXISTS comment_mentions (
      comment_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      PRIMARY KEY (comment_id, user_id),
      FOREIGN KEY (comment_id) REFERENCES task_comments(comment_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_notifications (
      notif_id     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      type         TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      task_title   TEXT NOT NULL,
      from_user_id TEXT,
      from_name    TEXT,
      read         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_notifs_user_read ON task_notifications(user_id, read);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      user_id    TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, endpoint)
    );

    CREATE TABLE IF NOT EXISTS admins (
      email TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS asset_link_groups (
      group_id           TEXT PRIMARY KEY,
      client_name        TEXT NOT NULL,
      shared_folder_name TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_asset_link_groups_client ON asset_link_groups(client_name);

    CREATE TABLE IF NOT EXISTS asset_merge_jobs (
      job_id             TEXT PRIMARY KEY,
      group_id           TEXT NOT NULL REFERENCES asset_link_groups(group_id),
      source_project_id  TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      conflict_payload   TEXT,
      resolution_payload TEXT,
      error_message      TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_merge_jobs_group  ON asset_merge_jobs(group_id);
    CREATE INDEX IF NOT EXISTS idx_merge_jobs_status ON asset_merge_jobs(status);

    CREATE TABLE IF NOT EXISTS asset_link_locks (
      project_id TEXT PRIMARY KEY,
      reason     TEXT NOT NULL,
      job_id     TEXT,
      locked_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prospect_access (
      user_id    TEXT PRIMARY KEY,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prospects (
      prospect_id TEXT PRIMARY KEY,
      company     TEXT NOT NULL,
      website     TEXT,
      industry    TEXT,
      source      TEXT,
      status      TEXT NOT NULL DEFAULT 'discovery',
      archived    INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      promoted_at TEXT,
      client_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prospects_status     ON prospects(status);
    CREATE INDEX IF NOT EXISTS idx_prospects_archived   ON prospects(archived);
    CREATE INDEX IF NOT EXISTS idx_prospects_created_by ON prospects(created_by);
    CREATE INDEX IF NOT EXISTS idx_prospects_updated_at ON prospects(updated_at DESC);

    CREATE TABLE IF NOT EXISTS prospect_users (
      prospect_id TEXT NOT NULL REFERENCES prospects(prospect_id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (prospect_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_prospect_users_user ON prospect_users(user_id);

    CREATE TABLE IF NOT EXISTS prospect_contacts (
      contact_id  TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES prospects(prospect_id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      role        TEXT,
      email       TEXT,
      phone       TEXT,
      linkedin    TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prospect_contacts_prospect ON prospect_contacts(prospect_id);

    CREATE TABLE IF NOT EXISTS prospect_updates (
      update_id   TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES prospects(prospect_id) ON DELETE CASCADE,
      author_id   TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      edited_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prospect_updates_prospect ON prospect_updates(prospect_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS prospect_status_history (
      history_id  TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES prospects(prospect_id) ON DELETE CASCADE,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      changed_by  TEXT NOT NULL,
      changed_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prospect_status_history_prospect ON prospect_status_history(prospect_id, changed_at DESC);

    CREATE TABLE IF NOT EXISTS clients (
      client_id   TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      prospect_id TEXT,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clients_prospect_id ON clients(prospect_id);

    CREATE TABLE IF NOT EXISTS prospect_notifications (
      notif_id     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      type         TEXT NOT NULL,
      prospect_id  TEXT NOT NULL,
      company      TEXT NOT NULL,
      from_user_id TEXT,
      from_name    TEXT,
      read         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prospect_notifs_user_read ON prospect_notifications(user_id, read);

    CREATE TABLE IF NOT EXISTS delivery_notifications (
      notif_id        TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      type            TEXT NOT NULL,
      delivery_token  TEXT NOT NULL,
      project_name    TEXT NOT NULL,
      client_name     TEXT,
      label           TEXT,
      description     TEXT,
      queue_summary   TEXT,
      user_agent      TEXT,
      href            TEXT,
      read            INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_notifs_user_read ON delivery_notifications(user_id, read);
  `);
}

function runMigrations(db: DatabaseSync): void {
  // v2: phase column on tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'pre_production'`);
    // Backfill: keep 'done', reset legacy statuses to the pre_production default
    db.exec(`UPDATE tasks SET status = 'onboarding' WHERE status NOT IN ('done')`);
  } catch {
    // Column already exists — migration already ran
  }

  // v3: slack_email override on users
  try {
    db.exec(`ALTER TABLE users ADD COLUMN slack_email TEXT`);
  } catch {
    // Column already exists — migration already ran
  }

  // v4: asset link group membership on projects
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN asset_link_group_id TEXT REFERENCES asset_link_groups(group_id)`);
  } catch {
    // Column already exists — migration already ran
  }

  // v5: per-project Cloudflare defaults (JSON blob)
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN cloudflare_defaults TEXT`);
  } catch {
    // Column already exists — migration already ran
  }

  // v6: People CRM — pre-close and post-close fields, simplified status
  const peopleCols = [
    'account_model TEXT',
    'revenue_type TEXT',
    'one_time_lp_revenue REAL',
    'monthly_lp_revenue REAL',
    'monthly_lp_tech_revenue REAL',
    'estimated_first_year_value REAL',
    'expected_start_month TEXT',
    'expansion_potential TEXT',
    'owner TEXT',
    'start_month TEXT',
    'recurring_billing_status TEXT',
    'renewal_date TEXT',
    'first_recurring_bill_date TEXT',
    'active_services TEXT',
    'next_film_date TEXT',
  ];
  for (const col of peopleCols) {
    try {
      db.exec(`ALTER TABLE prospects ADD COLUMN ${col}`);
    } catch {
      // Column already exists
    }
  }
  // Migrate sub-phase statuses → 'prospect', and 'promoted' → 'active'
  try {
    db.exec(`UPDATE prospects SET status = 'active' WHERE status = 'promoted'`);
    db.exec(`UPDATE prospects SET status = 'prospect' WHERE status IN ('discovery','proposal','contract_signed','blueprint')`);
  } catch {
    // Ignore
  }

  // v8: Tasks system v2 — replace `phase` (with pre_production) with `task_type` (editing|platform);
  // drop the obsolete `notes` and `project_id` columns; backfill client_name → 'General' if null.
  // Idempotency: the ADD COLUMN for task_type throws once it exists, so the whole block skips on re-run.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'editing'`);
    db.exec(`UPDATE tasks SET task_type = CASE phase WHEN 'platform' THEN 'platform' ELSE 'editing' END`);
    db.exec(`UPDATE tasks SET client_name = 'General' WHERE client_name IS NULL OR client_name = ''`);
    db.exec(`DROP INDEX IF EXISTS idx_tasks_project`);
    db.exec(`ALTER TABLE tasks DROP COLUMN project_id`);
    db.exec(`ALTER TABLE tasks DROP COLUMN phase`);
    db.exec(`ALTER TABLE tasks DROP COLUMN notes`);
  } catch {
    // task_type column already exists — v8 already ran
  }

  // Separate try block so the index gets created on fresh DBs too: the v8 ALTER
  // throws "duplicate column" on first boot of a fresh install (initSchema already
  // included task_type in the CREATE TABLE), which swallows the index create above
  // if it lives in the same try. CREATE INDEX IF NOT EXISTS is idempotent, so it's
  // safe to run unconditionally here.
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type)`);
  } catch {
    // task_type column doesn't exist yet — shouldn't happen post-v8, but tolerate
  }

  // v9: Tasks system v2 (F2) — add `category` column for Platform task grouping.
  // Nullable: Editing tasks never use it, Platform tasks created pre-F2 simply have NULL.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN category TEXT`);
  } catch {
    // Column already exists — v9 already ran
  }

  // v11: Phase E — Deliverables tables. CREATE TABLE IF NOT EXISTS is idempotent,
  // so this is safe to re-run. Older DBs that already shipped without these tables
  // get them on first boot after deploy; fresh DBs see them at initSchema time.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deliverables (
        deliverable_id   TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        name             TEXT NOT NULL,
        frameio_share_id TEXT NOT NULL,
        short_url        TEXT NOT NULL,
        expires_at       TEXT,
        settings_json    TEXT NOT NULL DEFAULT '{}',
        created_by       TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS deliverable_assets (
        deliverable_id   TEXT NOT NULL REFERENCES deliverables(deliverable_id) ON DELETE CASCADE,
        asset_id         TEXT NOT NULL,
        frameio_stack_id TEXT,
        frameio_file_id  TEXT,
        added_at         TEXT NOT NULL,
        PRIMARY KEY (deliverable_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS idx_deliverable_assets_asset ON deliverable_assets(asset_id);
    `);
  } catch (err) {
    console.warn('[core-db v11] deliverables tables create skipped:', (err as Error).message);
  }

  // v12: Phase E — backfill existing review links from the legacy
  // asset_share_links table into the new deliverables + deliverable_assets
  // tables. Idempotent via frameio_share_id existence check.
  //
  // We can't recover the per-asset Frame.io stack_id / file_id at migration
  // time (the media-registry lives outside core-db and reading it here would
  // pull a heavy dependency in). Both columns stay NULL on migrated rows —
  // the deliverable still resolves via frameio_share_id, and the auto-promote
  // path (E7) will refresh stack_id on the next v2 upload of any contained asset.
  try {
    const groupedShares = db.prepare(
      `SELECT project_id, share_id, name, share_url, MIN(created_at) AS created_at
         FROM asset_share_links
         GROUP BY project_id, share_id`,
    ).all() as Array<{
      project_id: string;
      share_id: string;
      name: string;
      share_url: string;
      created_at: string;
    }>;

    if (groupedShares.length > 0) {
      const checkExists = db.prepare(
        `SELECT deliverable_id FROM deliverables WHERE frameio_share_id = ? LIMIT 1`,
      );
      const insertDeliverable = db.prepare(
        `INSERT INTO deliverables
           (deliverable_id, project_id, name, frameio_share_id, short_url,
            expires_at, settings_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, '{}', 'system', ?, ?)`,
      );
      const fetchAssetMembers = db.prepare(
        `SELECT asset_id, created_at FROM asset_share_links
         WHERE project_id = ? AND share_id = ?`,
      );
      const insertMember = db.prepare(
        `INSERT INTO deliverable_assets
           (deliverable_id, asset_id, frameio_stack_id, frameio_file_id, added_at)
         VALUES (?, ?, NULL, NULL, ?)`,
      );

      let migrated = 0;
      for (const row of groupedShares) {
        const existing = checkExists.get(row.share_id);
        if (existing) continue;

        const deliverableId = randomUUIDStr();
        insertDeliverable.run(
          deliverableId,
          row.project_id,
          row.name,
          row.share_id,
          row.share_url,
          row.created_at,
          row.created_at,
        );

        const members = fetchAssetMembers.all(row.project_id, row.share_id) as Array<{
          asset_id: string; created_at: string;
        }>;
        for (const m of members) {
          insertMember.run(deliverableId, m.asset_id, m.created_at);
        }
        migrated++;
      }
      if (migrated > 0) {
        console.log(`[core-db v12] migrated ${migrated} legacy share(s) → deliverables`);
      }
    }
  } catch (err) {
    console.warn('[core-db v12] deliverable backfill skipped:', (err as Error).message);
  }

  // v13: Backfill Projects → People. Every distinct project.client_name (on a
  // non-archived project, non-empty) should have a corresponding prospect with
  // status='active'. Idempotency:
  //   - if a matching prospect (case-insensitive on company) exists and is
  //     'active' → no-op.
  //   - if it exists but isn't 'active' → flip to 'active' + record a
  //     status-history transition.
  //   - if it doesn't exist → INSERT one with status='active' and history.
  // Forward path (new projects + clientName changes) is wired in ProjectStore;
  // this migration covers the pre-existing rows.
  try {
    const clients = db
      .prepare(
        `SELECT DISTINCT TRIM(client_name) AS client_name
         FROM projects
         WHERE archived = 0 AND client_name IS NOT NULL AND TRIM(client_name) != ''`,
      )
      .all() as Array<{ client_name: string }>;

    if (clients.length > 0) {
      const findProspect = db.prepare(
        `SELECT prospect_id, status FROM prospects WHERE LOWER(TRIM(company)) = ? LIMIT 1`,
      );
      const promoteProspect = db.prepare(
        `UPDATE prospects SET status = 'active', promoted_at = ?, client_name = ?, updated_at = ? WHERE prospect_id = ?`,
      );
      const insertProspect = db.prepare(
        `INSERT INTO prospects
           (prospect_id, company, website, industry, source, status, archived,
            created_by, created_at, updated_at, promoted_at, client_name,
            account_model, revenue_type, one_time_lp_revenue, monthly_lp_revenue,
            monthly_lp_tech_revenue, estimated_first_year_value, expected_start_month,
            expansion_potential, owner, start_month, recurring_billing_status,
            renewal_date, first_recurring_bill_date, active_services, next_film_date)
         VALUES (?, ?, NULL, NULL, NULL, 'active', 0, 'system', ?, ?, ?, ?,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL)`,
      );
      const insertHistory = db.prepare(
        `INSERT INTO prospect_status_history
           (history_id, prospect_id, from_status, to_status, changed_by, changed_at)
         VALUES (?, ?, ?, ?, 'system', ?)`,
      );

      const now = new Date().toISOString();
      let created = 0;
      let promoted = 0;
      for (const { client_name } of clients) {
        const normalized = client_name.toLowerCase();
        const existing = findProspect.get(normalized) as
          | { prospect_id: string; status: string }
          | undefined;

        if (!existing) {
          const newId = randomUUIDStr();
          insertProspect.run(newId, client_name, now, now, now, client_name);
          insertHistory.run(randomUUIDStr(), newId, null, 'active', now);
          created++;
        } else if (existing.status !== 'active') {
          promoteProspect.run(now, client_name, now, existing.prospect_id);
          insertHistory.run(randomUUIDStr(), existing.prospect_id, existing.status, 'active', now);
          promoted++;
        }
      }
      if (created > 0 || promoted > 0) {
        console.log(`[core-db v13] backfilled People CRM: ${created} new prospect(s), ${promoted} promoted to active`);
      }
    }
  } catch (err) {
    console.warn('[core-db v13] Projects → People backfill skipped:', (err as Error).message);
  }

  // v14: Delivery trouble-report notifications. Idempotent — CREATE TABLE IF NOT
  // EXISTS is safe to re-run, and initSchema already includes this on fresh DBs.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_notifications (
        notif_id        TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        type            TEXT NOT NULL,
        delivery_token  TEXT NOT NULL,
        project_name    TEXT NOT NULL,
        client_name     TEXT,
        label           TEXT,
        description     TEXT,
        queue_summary   TEXT,
        user_agent      TEXT,
        href            TEXT,
        read            INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_notifs_user_read ON delivery_notifications(user_id, read);
    `);
  } catch (err) {
    console.warn('[core-db v14] delivery_notifications create skipped:', (err as Error).message);
  }

  // v10: Tasks system v2 (F3) — seed the task_categories table with the starter set.
  // Idempotent via count check: only seeds if the table is empty. After seeding, the
  // admin UI on /settings is the only path that mutates this list.
  try {
    const seedNow = new Date().toISOString();
    const seedRow = db.prepare(`SELECT COUNT(*) as cnt FROM task_categories`).get() as { cnt: number };
    if (seedRow.cnt === 0) {
      const seeds = [
        ['Pass Build',              0],
        ['Registration/Sales Page', 1],
        ['Workbooks',               2],
        ['Photos',                  3],
        ['Misc',                    4],
      ] as const;
      const insert = db.prepare(
        `INSERT INTO task_categories (category_id, label, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [label, order] of seeds) {
        insert.run(`seed-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label, order, seedNow, seedNow);
      }
    }
  } catch (err) {
    console.warn('[core-db v10] task_categories seed skipped:', (err as Error).message);
  }
}

export function getCoreDb(): DatabaseSync {
  if (globalThis.__lpos_core_db) return globalThis.__lpos_core_db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  runMigrations(db);
  globalThis.__lpos_core_db = db;
  return db;
}

export function withTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
