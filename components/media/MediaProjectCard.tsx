'use client';

import { MediaProject, AssetStatus } from '@/lib/demo-data/media-projects';

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  approved: 'Approved',
  published: 'Published',
};

interface Props {
  project: MediaProject;
  onSelect: (id: string) => void;
}

export function MediaProjectCard({ project, onSelect }: Readonly<Props>) {
  return (
    <button className="m-project-card" type="button" onClick={() => onSelect(project.projectId)}>
      <p className="m-project-client">{project.clientName}</p>
      <h3 className="m-project-name">{project.projectName}</h3>
      <div className="m-project-stats">
        <span>{project.videoCount} videos</span>
        <span>Round {project.currentRound}</span>
        <span>{project.lastActivity}</span>
      </div>
      <div className="m-project-footer">
        <span className={`m-status-badge m-status-badge--${project.status}`}>
          {STATUS_LABELS[project.status]}
        </span>
        {project.pendingReview > 0 && (
          <span className="m-project-pending">{project.pendingReview} pending review</span>
        )}
      </div>
    </button>
  );
}

export function MediaProjectRow({ project, onSelect }: Readonly<Props>) {
  return (
    <button className="m-project-row" type="button" onClick={() => onSelect(project.projectId)}>
      <span className="m-project-row-client">{project.clientName}</span>
      <span className="m-project-row-name">{project.projectName}</span>
      <span className="m-project-row-count">{project.videoCount}</span>
      <span className="m-project-row-round">R{project.currentRound}</span>
      <span className={`m-status-badge m-status-badge--${project.status}`}>
        {STATUS_LABELS[project.status]}
      </span>
      {project.pendingReview > 0 ? (
        <span className="m-project-row-pending">{project.pendingReview} pending</span>
      ) : (
        <span className="m-project-row-pending" />
      )}
      <span className="m-project-row-date">{project.lastActivity}</span>
      <svg className="m-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
    </button>
  );
}
