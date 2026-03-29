import { notFound } from 'next/navigation';
import { ProjectHeader } from '@/components/projects/ProjectHeader';
import { getProjectAssets, getProjectById, getProjectJobs } from '@/lib/selectors/projects';
import { listProjectTranscripts } from '@/lib/transcripts/store';
import { TranscriptPageActions } from '@/components/transcripts/TranscriptPageActions';

const formatMap = {
  transcript: 'JSON transcript',
  subtitle: 'Subtitle export',
  video: 'Source media'
} as const;

const queueStatusTone: Record<string, 'active' | 'ready' | 'idle'> = {
  running: 'active',
  completed: 'ready',
  queued: 'idle',
  blocked: 'idle'
};

const tools = [
  { name: 'Merge transcripts', description: 'Combine transcript passes, field notes, and speaker edits into one artifact.' },
  { name: 'Build bundle', description: 'Assemble transcript exports, subtitles, and metadata into the project handoff packet.' },
  { name: 'Podcast splitter', description: 'Prep a long-form source for clips, chapters, and downstream editorial trims.' }
];

export default async function ProjectTranscriptsPage({ params }: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;
  const project = getProjectById(projectId);
  if (!project) notFound();

  const transcriptAssets = getProjectAssets(projectId).filter((asset) =>
    ['video', 'transcript', 'subtitle'].includes(asset.type)
  );
  const transcriptJobs = getProjectJobs(projectId).filter((job) =>
    ['transcribe_media', 'build_project_bundle'].includes(job.type)
  );

  const hasCompletedTranscript = transcriptJobs.some((job) => job.type === 'transcribe_media' && job.status === 'completed');
  const storedTranscripts = listProjectTranscripts(projectId);
  const hasStoredTranscripts = storedTranscripts.length > 0;
  const queueCards = transcriptJobs.length > 0 ? transcriptJobs : [{
    jobId: 'mock-transcription', projectId, type: 'transcribe_media',
    status: 'queued', assignedTo: 'LPOS Host', progress: 0
  }];

  const archiveItems = hasCompletedTranscript
    ? ['Interview Transcript.json', 'Interview Subtitles.srt', 'Interview Run Log.txt']
    : ['No archived runs yet'];

  return (
    <div className="page-stack">
      <ProjectHeader project={project} />

      <section className="transcript-workspace">
        <div className="transcript-main-column">
          <section className="panel transcript-panel">
            <div className="transcript-dropzone">
              <p className="transcript-dropzone-title">Drag audio or video here</p>
              <div className="actions-row">
                <button type="button" className="btn">Upload files</button>
                <button type="button" className="btn-secondary">Choose intake folder</button>
              </div>
            </div>
            <div className="transcript-ingest-grid">
              <article className="transcript-mini-card">
                <span className="transcript-mini-label">Watch folder</span>
                <strong>\\LPOS\incoming\{project.projectId}</strong>
              </article>
              <article className="transcript-mini-card">
                <span className="transcript-mini-label">Routing</span>
                <strong>Project assets / transcripts</strong>
              </article>
            </div>
          </section>

          <section className="panel transcript-panel">
            <div className="actions-row">
              <button type="button" className="btn">Start queue</button>
              <button type="button" className="btn-secondary">Pause</button>
              <button type="button" className="btn-secondary">Archive completed</button>
            </div>
            <div className="transcript-queue-list">
              {queueCards.map((job, index) => (
                <article key={job.jobId} className="transcript-queue-card">
                  <div className="row-head">
                    <div>
                      <p className="transcript-queue-kicker">Job {index + 1}</p>
                      <strong>{job.type === 'transcribe_media' ? 'Transcribe source media' : 'Build project transcript bundle'}</strong>
                    </div>
                    <span className={`transcript-status-pill ${queueStatusTone[job.status] ?? 'idle'}`}>{job.status}</span>
                  </div>
                  <div className="row-meta">
                    <span>Assigned to: {job.assignedTo}</span>
                    <span>Source: {transcriptAssets.find((asset) => asset.type === 'video')?.name ?? 'Awaiting first upload'}</span>
                  </div>
                  <div className="transcript-progress">
                    <span className="transcript-progress-bar">
                      <span style={{ width: `${job.progress}%` }} />
                    </span>
                    <span className="transcript-progress-copy">{job.progress}%</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel transcript-panel">
            <TranscriptPageActions projectId={projectId} hasTranscripts={hasStoredTranscripts} />
            <div className="transcript-output-list">
              {transcriptAssets.length > 0 ? (
                transcriptAssets.map((asset) => (
                  <article key={asset.assetId} className="transcript-output-card">
                    <div className="row-head">
                      <strong>{asset.name}</strong>
                      <span className="tag">{formatMap[asset.type as keyof typeof formatMap] ?? asset.type}</span>
                    </div>
                    <div className="row-meta">
                      <span>Source: {asset.source}</span>
                      <span>Status: {asset.status}</span>
                    </div>
                  </article>
                ))
              ) : (
                <>
                  <article className="transcript-output-card">
                    <div className="row-head">
                      <strong>Main interview transcript.json</strong>
                      <span className="tag">Transcript JSON</span>
                    </div>
                    <div className="row-meta"><span>Status: Waiting for first run</span></div>
                  </article>
                  <article className="transcript-output-card">
                    <div className="row-head">
                      <strong>Main interview subtitles.srt</strong>
                      <span className="tag">Subtitle export</span>
                    </div>
                    <div className="row-meta"><span>Status: Waiting for first run</span></div>
                  </article>
                </>
              )}
            </div>
          </section>
        </div>

        <aside className="transcript-side-column">
          <section className="panel transcript-panel">
            <div className="transcript-settings-list">
              <div className="transcript-setting-row">
                <span className="transcript-setting-label">Model</span>
                <strong>Whisper base</strong>
              </div>
              <div className="transcript-setting-row">
                <span className="transcript-setting-label">Language</span>
                <strong>Auto detect</strong>
              </div>
              <div className="transcript-setting-row">
                <span className="transcript-setting-label">Outputs</span>
                <strong>TXT, timecoded TXT, SRT, VTT</strong>
              </div>
              <div className="transcript-setting-row">
                <span className="transcript-setting-label">Run log</span>
                <strong>Enabled</strong>
              </div>
              <div className="transcript-setting-row">
                <span className="transcript-setting-label">Destination</span>
                <strong>Project / transcripts / latest run</strong>
              </div>
            </div>
          </section>

          <section className="panel transcript-panel">
            <div className="transcript-tool-list">
              {tools.map((tool) => (
                <article key={tool.name} className="transcript-tool-card">
                  <strong>{tool.name}</strong>
                  <p>{tool.description}</p>
                  <button type="button" className="btn-secondary">Open tool</button>
                </article>
              ))}
            </div>
          </section>

          <section className="panel transcript-panel">
            <div className="transcript-archive-list">
              {archiveItems.map((item) => (
                <div key={item} className="transcript-archive-row">
                  <span>{item}</span>
                  <span className="muted">{hasCompletedTranscript ? 'Completed run' : 'Pending'}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}
