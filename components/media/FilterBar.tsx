'use client';

import { type ReactNode } from 'react';
import { AssetStatus } from '@/lib/demo-data/media-projects';

const STATUSES: { value: AssetStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'in_review', label: 'In Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'published', label: 'Published' },
];

const ROUNDS = ['all', '1', '2', '3'] as const;

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: AssetStatus | 'all';
  onStatusChange: (v: AssetStatus | 'all') => void;
  roundFilter: string;
  onRoundChange: (v: string) => void;
  showRound?: boolean;
  rightSlot?: ReactNode;
}

export function FilterBar({
  search, onSearchChange,
  statusFilter, onStatusChange,
  roundFilter, onRoundChange,
  showRound = false,
  rightSlot,
}: Readonly<Props>) {
  return (
    <div className="m-filter-bar">
      <input
        className="m-filter-search"
        type="text"
        placeholder="Search..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <div className="m-filter-pills">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            className={`m-filter-pill${statusFilter === s.value ? ' active' : ''}`}
            type="button"
            onClick={() => onStatusChange(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {showRound && (
        <div className="m-filter-pills">
          {ROUNDS.map((r) => (
            <button
              key={r}
              className={`m-filter-pill${roundFilter === r ? ' active' : ''}`}
              type="button"
              onClick={() => onRoundChange(r)}
            >
              {r === 'all' ? 'All Rounds' : `R${r}`}
            </button>
          ))}
        </div>
      )}
      {rightSlot && <div className="m-filter-right">{rightSlot}</div>}
    </div>
  );
}
