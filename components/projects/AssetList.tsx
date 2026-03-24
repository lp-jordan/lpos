import { Asset } from '@/lib/models/asset';

export function AssetList({ items }: Readonly<{ items: Asset[] }>) {
  return (
    <div className="asset-list">
      {items.map((item) => (
        <article key={item.assetId} className="asset-item">
          <div className="row-head">
            <strong>{item.name}</strong>
            <span className="tag">{item.type}</span>
          </div>
          <div className="row-meta">
            <span>Source: {item.source}</span>
            <span>Status: {item.status}</span>
          </div>
        </article>
      ))}
    </div>
  );
}
