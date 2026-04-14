import { randomUUID } from 'node:crypto';
import type { User, UserSummary } from '@/lib/models/user';
import { getCoreDb } from './core-db';

interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  avatar_url: string | null;
  slack_email: string | null;
  created_at: string;
  last_login_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    googleSub: row.google_sub,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    slackEmail: row.slack_email ?? null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function getUserById(id: string): User | null {
  const row = getCoreDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function getUserByGoogleSub(googleSub: string): User | null {
  const row = getCoreDb().prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function upsertGoogleUser(input: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}): User {
  const db = getCoreDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(input.googleSub) as UserRow | undefined;

  if (existing) {
    db.prepare(
      'UPDATE users SET email = ?, name = ?, avatar_url = ?, last_login_at = ? WHERE google_sub = ?',
    ).run(input.email, input.name, input.avatarUrl, now, input.googleSub);
    return rowToUser({ ...existing, email: input.email, name: input.name, avatar_url: input.avatarUrl, last_login_at: now });
  }

  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, google_sub, email, name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.googleSub, input.email, input.name, input.avatarUrl, now, now);
  return { id, googleSub: input.googleSub, email: input.email, name: input.name, avatarUrl: input.avatarUrl, slackEmail: null, createdAt: now, lastLoginAt: now };
}

const GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';

export function getOrCreateGuestUser(): User {
  const db = getCoreDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO users (id, google_sub, email, name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(GUEST_USER_ID, 'guest', 'guest@local', 'Guest', null, now, now);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, GUEST_USER_ID);
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(GUEST_USER_ID) as UserRow);
}

export function getAllUsers(): User[] {
  return (getCoreDb().prepare('SELECT * FROM users').all() as UserRow[]).map(rowToUser);
}

export function setSlackEmail(userId: string, slackEmail: string | null): void {
  getCoreDb()
    .prepare('UPDATE users SET slack_email = ? WHERE id = ?')
    .run(slackEmail ?? null, userId);
}

export function toUserSummary(user: User | null): UserSummary | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    isGuest: user.id === GUEST_USER_ID,
  };
}
