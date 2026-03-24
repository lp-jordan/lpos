import { PublishRecord } from '@/lib/models/publish-record';

export function PublishCard({ record }: Readonly<{ record: PublishRecord }>) {
  return (
    <article className="media-item">
      <div className="row-head">
        <strong>{record.destination}</strong>
        <span className="tag">{record.status}</span>
      </div>
      <div className="row-meta">
        <span>Project: {record.projectId}</span>
        <span>{record.url}</span>
      </div>
    </article>
  );
}
