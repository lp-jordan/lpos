import { Event } from '@/lib/models/event';

export function Timeline({ items }: Readonly<{ items: Event[] }>) {
  return (
    <div className="timeline-list">
      {items.map((item) => (
        <article key={item.eventId} className="timeline-item">
          <div className="row-head">
            <strong>{item.message}</strong>
            <span className="tag">{item.timestamp}</span>
          </div>
          <div className="row-meta">
            <span>{item.type}</span>
          </div>
        </article>
      ))}
    </div>
  );
}
