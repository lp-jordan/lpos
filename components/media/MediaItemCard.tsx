import { MediaItem } from '@/lib/models/media-item';

export function MediaItemCard({ item }: Readonly<{ item: MediaItem }>) {
  return (
    <article className="media-item">
      <div className="row-head">
        <strong>{item.title}</strong>
        <span className={`tag${item.provider === 'sardius' ? ' warning' : ''}`}>{item.provider}</span>
      </div>
      <div className="row-meta">
        <span>{item.clientName}</span>
        <span>{item.collection}</span>
        <span>{item.category}</span>
      </div>
      <div className="row-meta">
        <span>Status: {item.status}</span>
        <span>Duration: {item.duration}</span>
      </div>
      <div className="row-meta">
        <span>{item.folderPath}</span>
      </div>
    </article>
  );
}
