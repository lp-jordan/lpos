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
      comment_id  TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      body        TEXT NOT NULL,
      author_id   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      edited_at   TEXT,
      kind        TEXT NOT NULL DEFAULT 'comment',
      metadata    TEXT,
      attachments TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task   ON task_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_author ON task_comments(author_id);
    -- NOTE: idx_task_comments_kind is created in runMigrations v20 AFTER the
    -- ALTER TABLE that adds the kind column. Putting the index here would
    -- fire BEFORE the ALTER on existing DBs (CREATE TABLE IF NOT EXISTS is a
    -- no-op, so the kind column would not exist yet) and crash startup with
    -- "no such column: kind". Fresh DBs still get the index -- runMigrations
    -- runs immediately after initSchema in getCoreDb().

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

    CREATE TABLE IF NOT EXISTS editpanel_access (
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

    -- Media-asset (Frame.io) comment notifications. One row per reply landing
    -- on a comment the recipient authored from within LPOS. asset_name/snippet
    -- are display snapshots; deep-link target is /projects/{id}?assetId={asset}.
    CREATE TABLE IF NOT EXISTS comment_notifications (
      notif_id     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      type         TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      asset_id     TEXT NOT NULL,
      asset_name   TEXT NOT NULL,
      comment_id   TEXT NOT NULL,
      from_user_id TEXT,
      from_name    TEXT,
      snippet      TEXT,
      read         INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comment_notifs_user_read ON comment_notifications(user_id, read);

    -- EditPanel auth tokens: one row per (user, machine) approval, minted via the
    -- /ep/link approval flow. Raw token is only ever returned at mint time and
    -- stored in editpanel's local config; the DB only sees its sha256 hash.
    CREATE TABLE IF NOT EXISTS ep_tokens (
      token_id     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      machine_name TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ep_tokens_user    ON ep_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_ep_tokens_active  ON ep_tokens(revoked_at);

    -- B2 media sync configuration — operational knobs that admins tune at
    -- runtime (not credentials, which stay in env/Doppler). Single-row table
    -- with id=1; B2MediaSyncService reads this on every tick so changes
    -- take effect within ~1 minute.
    CREATE TABLE IF NOT EXISTS b2_sync_config (
      config_id   INTEGER PRIMARY KEY CHECK (config_id = 1),
      sync_dirs   TEXT NOT NULL DEFAULT '[]',  -- JSON array of absolute paths
      retain_days INTEGER NOT NULL DEFAULT 30,
      sync_hour   INTEGER NOT NULL DEFAULT 2,  -- 0–23
      updated_at  TEXT NOT NULL
    );

    -- Raw-footage cold-storage tracking — one row per object that has ever been
    -- uploaded to B2. Drives the retention model: an object is only deleted
    -- from B2 after it has been missing from every source dir for retain_days
    -- consecutive nights. missing_since is NULL while the source file is
    -- present; gets set on the first sync that can't find it locally; gets
    -- cleared again if the source file reappears within the retention window.
    -- deleted_at is set when the B2 object is finally removed (kept around as
    -- audit history; pruned by an opportunistic sweep after 90 days).
    CREATE TABLE IF NOT EXISTS b2_cold_storage_objects (
      key            TEXT PRIMARY KEY,
      size           INTEGER NOT NULL,
      uploaded_at    TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      missing_since  TEXT,
      deleted_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cold_storage_missing ON b2_cold_storage_objects(missing_since) WHERE missing_since IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cold_storage_active  ON b2_cold_storage_objects(deleted_at) WHERE deleted_at IS NULL;

    -- Task handoffs — explicit chain-of-custody events tracked separately from
    -- task_comments so the stale-activity monitor can do a cheap partial-indexed
    -- sweep without scanning the (large) comments table. The companion comment
    -- row in task_comments (kind='handoff') is the human-readable artifact;
    -- this row is the machine-readable monitor state. See docs for the
    -- "completed" semantics — only real activity by a target assignee
    -- (status_change | comment) flips completed_at; ack resets next_check_at
    -- but does NOT complete the handoff.
    CREATE TABLE IF NOT EXISTS task_handoffs (
      handoff_id        TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
      from_user_id      TEXT NOT NULL,
      to_user_ids       TEXT NOT NULL,          -- JSON array of user IDs
      prior_assignees   TEXT NOT NULL,          -- JSON array, for audit
      note              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      ack_at            TEXT,
      ack_user_id       TEXT,
      completed_at      TEXT,
      completed_reason  TEXT,                   -- 'status_change' | 'comment' | 'next_handoff' | 'manual'
      next_check_at     TEXT,                   -- NULL once completed
      last_alert_at     TEXT,
      alert_count       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_task    ON task_handoffs(task_id);
    CREATE INDEX IF NOT EXISTS idx_handoffs_pending ON task_handoffs(next_check_at) WHERE completed_at IS NULL;

    -- Generic operational-knob KV (per workspace memory feedback_doppler_vs_admin_settings:
    -- knobs go in SQLite, not Doppler — credentials stay in Doppler). Values
    -- are JSON-encoded so the same table holds numbers, strings, booleans, and
    -- small arrays/objects. Used by MonitorRegistry monitors for their per-
    -- monitor thresholds + enable toggles.
    CREATE TABLE IF NOT EXISTS lpos_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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

  // v15: NAS ingest access flag on users.
  try {
    db.exec(`ALTER TABLE users ADD COLUMN nas_ingest_access INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // v15b: NAS ingest *active* flag — the user's persisted toggle state, distinct
  // from the access permission. Recovered after a `git checkout HEAD -- .` wipe.
  try {
    db.exec(`ALTER TABLE users ADD COLUMN nas_ingest_active INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // v16: isParent flag on clients — marks umbrella org clients.
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN is_parent INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // v17: Attachments — JSON array on prospect_updates and task_comments rows.
  // Recovered after a `git checkout HEAD -- .` wipe. Originally numbered v15 in
  // the source session (2026-05-19), but v15/v16 are now occupied by the
  // nas_ingest_access + is_parent migrations that landed in the meantime.
  try {
    db.exec(`ALTER TABLE prospect_updates ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE task_comments ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    // Column already exists
  }

  // v18: Entity type on prospects — Individual or Organization.
  // Existing rows default to 'individual'. Recovered alongside v17 — original
  // session intended this as v16.
  try {
    db.exec(`ALTER TABLE prospects ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'individual'`);
  } catch {
    // Column already exists
  }

  // v19: paused flag on b2_sync_config — admin pause toggle for nightly cold-
  // storage sync. When 1, tick() returns early; manual Sync Now still works
  // (admin opt-in override). Defaults to 0.
  try {
    db.exec(`ALTER TABLE b2_sync_config ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // v20: Task handoff feature — kind+metadata on task_comments (so handoff
  // entries are typed alongside regular comments), task_handoffs table (machine-
  // readable monitor state, separate from the comment thread so the stale-
  // activity monitor can use a partial index), and lpos_settings KV for the
  // MonitorRegistry's per-monitor knobs.
  try {
    db.exec(`ALTER TABLE task_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment'`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE task_comments ADD COLUMN metadata TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_comments_kind ON task_comments(task_id, kind)`);
  } catch {
    // Index create is idempotent on its own; defensively wrapped for symmetry
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_handoffs (
        handoff_id        TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        from_user_id      TEXT NOT NULL,
        to_user_ids       TEXT NOT NULL,
        prior_assignees   TEXT NOT NULL,
        note              TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        ack_at            TEXT,
        ack_user_id       TEXT,
        completed_at      TEXT,
        completed_reason  TEXT,
        next_check_at     TEXT,
        last_alert_at     TEXT,
        alert_count       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_handoffs_task    ON task_handoffs(task_id);
      CREATE INDEX IF NOT EXISTS idx_handoffs_pending ON task_handoffs(next_check_at) WHERE completed_at IS NULL;
    `);
  } catch (err) {
    console.warn('[core-db v20] task_handoffs create skipped:', (err as Error).message);
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lpos_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  } catch (err) {
    console.warn('[core-db v20] lpos_settings create skipped:', (err as Error).message);
  }

  // v21: Pre-Production task board — configurable per-type kanban columns,
  // plus a per-user "can edit columns" access list. Columns are intentionally
  // empty by default — admin must add them via /dashboard's column editor.
  // Schema is generic per task_type so we can extend configurability to other
  // task types later without another migration.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_phase_configs (
        config_id   TEXT PRIMARY KEY,
        task_type   TEXT NOT NULL,
        slug        TEXT NOT NULL,
        label       TEXT NOT NULL,
        color       TEXT NOT NULL,
        sort_order  INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE (task_type, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_task_phase_configs_type
        ON task_phase_configs(task_type, sort_order);
    `);
  } catch (err) {
    console.warn('[core-db v21] task_phase_configs create skipped:', (err as Error).message);
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS preprod_board_admins (
        user_id    TEXT PRIMARY KEY,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL
      );
    `);
  } catch (err) {
    console.warn('[core-db v21] preprod_board_admins create skipped:', (err as Error).message);
  }

  // v22: People CRM — referred_by (free-text) + prospect_stage (funnel badge on
  // prospects). Both nullable; pre-v22 rows default to NULL on both fields.
  // prospect_stage is a free-string slug from a fixed enum (see PROSPECT_STAGES
  // in lib/models/prospect.ts); enforcing at the DB layer doesn't buy much vs
  // application-layer validation, and leaves room for future stage tweaks.
  try {
    db.exec(`ALTER TABLE prospects ADD COLUMN referred_by TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE prospects ADD COLUMN prospect_stage TEXT`);
  } catch {
    // Column already exists
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
