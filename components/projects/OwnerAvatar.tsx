'use client';

import type { UserSummary } from '@/lib/models/user';

interface Props {
  user: UserSummary;
  size?: number;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function OwnerAvatar({ user, size = 22 }: Props) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.name}
        width={size}
        height={size}
        className="owner-avatar"
        title={user.name}
      />
    );
  }
  return (
    <span
      className="owner-avatar owner-avatar--initials"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      title={user.name}
    >
      {getInitials(user.name)}
    </span>
  );
}
