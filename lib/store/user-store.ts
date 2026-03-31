import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { User, UserSummary } from '@/lib/models/user';

const USERS_PATH = path.join(process.cwd(), 'data', 'users.json');

interface UsersFile {
  users: User[];
}

function readUsersFile(): UsersFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8')) as Partial<UsersFile>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
    };
  } catch {
    return { users: [] };
  }
}

function writeUsersFile(file: UsersFile): void {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(file, null, 2), 'utf-8');
}

export function getUserById(id: string): User | null {
  return readUsersFile().users.find((user) => user.id === id) ?? null;
}

export function getUserByGoogleSub(googleSub: string): User | null {
  return readUsersFile().users.find((user) => user.googleSub === googleSub) ?? null;
}

export function upsertGoogleUser(input: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}): User {
  const now = new Date().toISOString();
  const file = readUsersFile();
  const existing = file.users.find((user) => user.googleSub === input.googleSub);

  if (existing) {
    existing.email = input.email;
    existing.name = input.name;
    existing.avatarUrl = input.avatarUrl;
    existing.lastLoginAt = now;
    writeUsersFile(file);
    return existing;
  }

  const created: User = {
    id: randomUUID(),
    googleSub: input.googleSub,
    email: input.email,
    name: input.name,
    avatarUrl: input.avatarUrl,
    createdAt: now,
    lastLoginAt: now,
  };

  file.users.push(created);
  writeUsersFile(file);
  return created;
}

const GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';

export function getOrCreateGuestUser(): User {
  const now = new Date().toISOString();
  const file = readUsersFile();
  const existing = file.users.find((u) => u.id === GUEST_USER_ID);
  if (existing) {
    existing.lastLoginAt = now;
    writeUsersFile(file);
    return existing;
  }
  const guest: User = {
    id: GUEST_USER_ID,
    googleSub: 'guest',
    email: 'guest@local',
    name: 'Guest',
    avatarUrl: null,
    createdAt: now,
    lastLoginAt: now,
  };
  file.users.push(guest);
  writeUsersFile(file);
  return guest;
}

export function getAllUsers(): User[] {
  return readUsersFile().users;
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
