import { notFound } from 'next/navigation';
import { AssetList } from '@/components/projects/AssetList';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { getProjectAssets, getProjectById, getProjectPublishRecords } from '@/lib/selectors/projects';

export default async function ProjectDeliveryPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const deliveryAssets = getProjectAssets(projectId).filter((asset) =>
    ['workbook', 'published_media'].includes(asset.type)
  );
  const records = getProjectPublishRecords(projectId);

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />
      <section className="two-column">
        <div className="panel">
          <AssetList items={deliveryAssets} />
        </div>
        <div className="panel">
          {records.length > 0 ? (
            <div className="media-list">
              {records.map((record) => (
                <article key={record.publishRecordId} className="media-item">
                  <div className="row-head">
                    <strong>{record.destination}</strong>
                  </div>
                  <div className="row-meta">
                    <span>{record.url}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="machine-free-note">No delivery records yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
