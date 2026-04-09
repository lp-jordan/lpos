export type UserRole = 'admin' | 'user' | 'guest';

export interface User {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isGuest: boolean;
}

/** Fixed ID for the shared guest account. */
export const GUEST_USER_ID = '00000000-0000-0000-0000-000000000001';
