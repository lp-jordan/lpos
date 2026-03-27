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
}
