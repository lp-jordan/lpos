import { MediaCollection } from '@/lib/models/media-collection';

export function CollectionCard({ collection }: Readonly<{ collection: MediaCollection }>) {
  return (
    <article className="project-card">
      <div className="row-head">
        <div>
          <p className="eyebrow">{collection.clientName}</p>
          <h2 className="project-title">{collection.name}</h2>
        </div>
        <span className="tag">{collection.itemCount} items</span>
      </div>
      <p className="page-copy">{collection.description}</p>
    </article>
  );
}
