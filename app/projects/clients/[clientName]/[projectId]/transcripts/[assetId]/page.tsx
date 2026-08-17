import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProjectById } from '@/lib/selectors/projects';
import { loadTranscriptEditorPayload } from '@/lib/transcripts/editor-payload';
import { TranscriptEditor } from '@/components/transcripts/TranscriptEditor';
import { projectHref } from '@/lib/urls/project-url';

type Params = Promise<{ clientName: string; projectId: string; assetId: string }>;

export default async function TranscriptEditorPage({ params }: Readonly<{ params: Params }>) {
  const { clientName, projectId, assetId } = await params;

  const project = getProjectById(projectId);
  if (!project) notFound();

  const payload = loadTranscriptEditorPayload(projectId, assetId);
  if (!payload) notFound();

  // An asset with no finished transcript has nothing to edit — say so rather
  // than rendering an empty grid.
  if (!payload.en && !payload.es) {
    return (
      <div className="page-stack">
        <section className="panel">
          <h1 className="te-title">No transcript yet</h1>
          <p className="muted">
            {payload.assetName} hasn’t been transcribed, so there are no captions to edit.
            Transcribe it from the Media tab first.
          </p>
          <Link className="btn-secondary" href={projectHref(clientName, projectId, 'media')}>
            Back to media
          </Link>
        </section>
      </div>
    );
  }

  return (
    <TranscriptEditor
      projectId={projectId}
      clientName={clientName}
      projectName={project.name}
      initial={payload}
    />
  );
}
