import { Job } from '@/lib/models/job';

export function JobList({ items }: Readonly<{ items: Job[] }>) {
  return (
    <div className="job-list">
      {items.map((item) => (
        <article key={item.jobId} className="job-item">
          <div className="row-head">
            <strong>{item.type}</strong>
            <span className={`tag${item.status === 'blocked' ? ' warning' : ''}`}>{item.status}</span>
          </div>
          <div className="row-meta">
            <span>Assigned: {item.assignedTo}</span>
            <span>Progress: {item.progress}%</span>
          </div>
        </article>
      ))}
    </div>
  );
}
