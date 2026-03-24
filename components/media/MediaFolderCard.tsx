'use client';

import { MediaFolder } from '@/lib/demo-data/media-folders';

interface Props {
  folder: MediaFolder;
  onSelect: (folderId: string) => void;
  isOpen: boolean;
}

export function MediaFolderCard({ folder, onSelect, isOpen }: Readonly<Props>) {
  return (
    <button
      className={`dam-folder-card${isOpen ? ' dam-folder-card--open' : ''}`}
      onClick={() => onSelect(folder.folderId)}
      type="button"
    >
      <div className="dam-folder-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      </div>
      <div className="dam-folder-info">
        <strong className="dam-folder-name">{folder.name}</strong>
        <span className="dam-folder-meta">{folder.clientName}</span>
        <span className="dam-folder-meta">{folder.videoCount} videos &middot; {folder.totalDuration}</span>
      </div>
      <span className="dam-folder-date">{folder.lastUpdated}</span>
    </button>
  );
}
