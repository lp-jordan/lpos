const actionsBySection: Record<string, string[]> = {
  overview: ['Upload Scripts', 'Queue Transcription', 'Create Bundle'],
  scripts: ['Upload Scripts', 'Assign to Prompter', 'Push Latest Packet'],
  shoot: ['Log Shoot Note', 'Open Live Session', 'Mark Shoot Complete'],
  transcripts: ['Upload Video', 'Queue Transcription', 'Run Podcast Splitter'],
  editorial: ['Create Edit Task', 'Assign to Editor', 'Upload Editorial Export'],
  'pass-prep': ['Open Pass Prep', 'Generate Course Plan', 'Generate Workbook'],
  delivery: ['Approve Delivery', 'Publish to Media Hub', 'Copy Delivery Link']
};

export function WorkflowActions({ section }: Readonly<{ section: string }>) {
  const actions = actionsBySection[section] ?? actionsBySection.overview;

  return (
    <div className="actions-row">
      {actions.map((action, index) => (
        <button key={action} type="button" className={index === 0 ? 'btn' : 'btn-secondary'}>
          {action}
        </button>
      ))}
    </div>
  );
}
