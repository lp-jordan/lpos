import { Event } from '@/lib/models/event';

export function ActivityFeed({ items }: Readonly<{ items: Event[] }>) {
  return (
    <div className="activity-list">
      {items.map((item) => (
        <article key={item.eventId} className="activity-item">
          <div className="row-head">
            <strong>{item.message}</strong>
            <span className="tag">{item.timestamp}</span>
          </div>
          <div className="row-meta">
            <span>{item.projectId}</span>
            <span>{item.type}</span>
          </div>
        </article>
      ))}
    </div>
  );
}
