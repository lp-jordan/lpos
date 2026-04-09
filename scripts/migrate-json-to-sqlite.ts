/**
 * One-time migration: reads existing JSON flat files and seeds them into lpos-core.sqlite.
 *
 * Safe to run multiple times — all inserts use INSERT OR IGNORE so existing rows are skipped.
 *
 * Run with:  npm run migrate:json-to-sqlite
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCoreDb } from '@/lib/store/core-db';

const DATA_DIR = process.env.LPOS_DATA_DIR ?? path.join(process.cwd(), 'data');

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

const db = getCoreDb();
let total = 0;

// ── users.json ──────────────────────────────────────────────────────────────

interface UserJson {
  users: {
    id: string;
    googleSub: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    createdAt: string;
    lastLoginAt: string;
  }[];
}

const usersFile = readJson<UserJson>(path.join(DATA_DIR, 'users.json'));
if (usersFile?.users?.length) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO users (id, google_sub, email, name, avatar_url, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const u of usersFile.users) {
    const result = stmt.run(u.id, u.googleSub, u.email, u.name, u.avatarUrl, u.createdAt, u.lastLoginAt) as { changes: number };
    count += result.changes;
  }
  console.log(`users: ${count} inserted (${usersFile.users.length} in file)`);
  total += count;
} else {
  console.log('users: no file or empty');
}

// ── projects.json ───────────────────────────────────────────────────────────

interface ProjectJson {
  projectId: string;
  name: string;
  clientName: string;
  phase: string;
  subPhase: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

const projects = readJson<ProjectJson[]>(path.join(DATA_DIR, 'projects.json'));
if (projects?.length) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO projects (project_id, name, client_name, phase, sub_phase, created_at, updated_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const p of projects) {
    const result = stmt.run(
      p.projectId, p.name, p.clientName,
      p.phase ?? 'pre_production', p.subPhase ?? 'discovery',
      p.createdAt, p.updatedAt, p.archived === true ? 1 : 0,
    ) as { changes: number };
    count += result.changes;
  }
  console.log(`projects: ${count} inserted (${projects.length} in file)`);
  total += count;
} else {
  console.log('projects: no file or empty');
}

// ── tasks.json ───────────────────────────────────────────────────────────────

interface TaskJson {
  tasks: {
    taskId: string;
    description: string;
    projectId: string;
    clientName?: string | null;
    priority?: string;
    status?: string;
    notes?: string | null;
    createdBy: string;
    assignedTo: string[];
    createdAt: string;
    completedAt?: string;
    completed?: boolean; // legacy field
  }[];
}

const tasksFile = readJson<TaskJson>(path.join(DATA_DIR, 'tasks.json'));
if (tasksFile?.tasks?.length) {
  const taskStmt = db.prepare(
    `INSERT OR IGNORE INTO tasks (task_id, description, project_id, client_name, priority, status, notes, created_by, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const assigneeStmt = db.prepare(
    'INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)',
  );

  let count = 0;
  db.exec('BEGIN');
  try {
    for (const t of tasksFile.tasks) {
      // Normalise legacy status values
      const rawStatus = t.status === 'todo' ? 'not_started' : (t.status ?? (t.completed ? 'done' : 'not_started'));
      const result = taskStmt.run(
        t.taskId, t.description, t.projectId ?? 'unassigned',
        t.clientName ?? null, t.priority ?? 'medium', rawStatus,
        t.notes ?? null, t.createdBy, t.createdAt,
        rawStatus === 'done' ? (t.completedAt ?? t.createdAt) : null,
      ) as { changes: number };
      if (result.changes > 0) {
        count++;
        for (const userId of (t.assignedTo ?? [])) {
          assigneeStmt.run(t.taskId, userId);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`tasks: ${count} inserted (${tasksFile.tasks.length} in file)`);
  total += count;
} else {
  console.log('tasks: no file or empty');
}

// ── wishes.json ──────────────────────────────────────────────────────────────

interface WishJson {
  wishes: {
    wishId: string;
    title: string;
    description?: string;
    submittedBy: string;
    submittedByName: string;
    completed: boolean;
    createdAt: string;
    completedAt?: string;
  }[];
}

const wishesFile = readJson<WishJson>(path.join(DATA_DIR, 'wishes.json'));
if (wishesFile?.wishes?.length) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO wishes (wish_id, title, description, submitted_by, submitted_by_name, completed, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const w of wishesFile.wishes) {
    const result = stmt.run(
      w.wishId, w.title, w.description ?? null,
      w.submittedBy, w.submittedByName,
      w.completed ? 1 : 0, w.createdAt, w.completedAt ?? null,
    ) as { changes: number };
    count += result.changes;
  }
  console.log(`wishes: ${count} inserted (${wishesFile.wishes.length} in file)`);
  total += count;
} else {
  console.log('wishes: no file or empty');
}

// ── client-owners.json ───────────────────────────────────────────────────────

const clientOwners = readJson<Record<string, string>>(path.join(DATA_DIR, 'client-owners.json'));
if (clientOwners && typeof clientOwners === 'object') {
  const entries = Object.entries(clientOwners);
  if (entries.length > 0) {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO client_owners (client_name, user_id) VALUES (?, ?)',
    );
    let count = 0;
    for (const [clientName, userId] of entries) {
      const result = stmt.run(clientName, userId) as { changes: number };
      count += result.changes;
    }
    console.log(`client-owners: ${count} inserted (${entries.length} in file)`);
    total += count;
  } else {
    console.log('client-owners: file is empty');
  }
} else {
  console.log('client-owners: no file');
}

// ── per-project: share-assets.json & asset-share-links.json ─────────────────

const projectsDir = path.join(DATA_DIR, 'projects');
let shareAssetsCount = 0;
let shareLinksCount = 0;

if (fs.existsSync(projectsDir)) {
  const projectIds = fs.readdirSync(projectsDir).filter((entry) =>
    fs.statSync(path.join(projectsDir, entry)).isDirectory(),
  );

  const shareAssetsStmt = db.prepare(
    `INSERT OR IGNORE INTO share_assets (project_id, share_id, file_ids) VALUES (?, ?, ?)`,
  );
  const shareLinksStmt = db.prepare(
    `INSERT OR IGNORE INTO asset_share_links (project_id, asset_id, share_id, share_url, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const projectId of projectIds) {
    // share-assets.json: { [shareId]: string[] }
    const shareAssets = readJson<Record<string, string[]>>(
      path.join(projectsDir, projectId, 'share-assets.json'),
    );
    if (shareAssets) {
      for (const [shareId, fileIds] of Object.entries(shareAssets)) {
        const result = shareAssetsStmt.run(projectId, shareId, JSON.stringify(fileIds)) as { changes: number };
        shareAssetsCount += result.changes;
      }
    }

    // asset-share-links.json: { [assetId]: AssetShareLink[] }
    interface LinkJson {
      shareId: string;
      shareUrl: string;
      name: string;
      createdAt: string;
    }
    const shareLinks = readJson<Record<string, LinkJson[]>>(
      path.join(projectsDir, projectId, 'asset-share-links.json'),
    );
    if (shareLinks) {
      for (const [assetId, links] of Object.entries(shareLinks)) {
        for (const link of links) {
          const result = shareLinksStmt.run(
            projectId, assetId, link.shareId, link.shareUrl, link.name, link.createdAt,
          ) as { changes: number };
          shareLinksCount += result.changes;
        }
      }
    }
  }
}

console.log(`share-assets: ${shareAssetsCount} rows inserted`);
console.log(`asset-share-links: ${shareLinksCount} rows inserted`);
total += shareAssetsCount + shareLinksCount;

// ── admins.json ──────────────────────────────────────────────────────────────

interface AdminsJson {
  emails: string[];
}

const adminsFile = readJson<AdminsJson>(path.join(DATA_DIR, 'admins.json'));
if (adminsFile?.emails?.length) {
  const stmt = db.prepare('INSERT OR IGNORE INTO admins (email) VALUES (?)');
  let count = 0;
  for (const email of adminsFile.emails) {
    const normalised = email.toLowerCase().trim();
    if (!normalised) continue;
    const result = stmt.run(normalised) as { changes: number };
    count += result.changes;
  }
  console.log(`admins: ${count} inserted (${adminsFile.emails.length} in file)`);
  total += count;
} else {
  console.log('admins: no file or empty');
}

console.log(`\nDone. ${total} total rows inserted into lpos-core.sqlite.`);
