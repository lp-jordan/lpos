export type TaskPhase = 'pre_production' | 'editing' | 'platform';

export interface PhaseStatus {
  value: string;
  label: string;
  color: string;
}

export interface PhaseConfig {
  value: TaskPhase;
  label: string;
  statuses: PhaseStatus[];
  defaultStatus: string;
  terminalStatus: string;
}

export const PHASE_CONFIGS: PhaseConfig[] = [
  {
    value: 'pre_production',
    label: 'Pre-Production',
    defaultStatus: 'onboarding',
    terminalStatus: 'done',
    statuses: [
      { value: 'onboarding',           label: 'Onboarding',          color: '#c9a227' },
      { value: 'lab_blueprint',        label: 'LAB / Blueprint',     color: '#d4943a' },
      { value: 'collecting_assets',    label: 'Collecting Assets',   color: '#5a6478' },
      { value: 'content_development',  label: 'Content Development', color: '#c45d7e' },
      { value: 'content_map',          label: 'Content Map',         color: '#2db394' },
      { value: 'set_design',           label: 'Set Design',          color: '#4a8fd4' },
      { value: 'done',                 label: 'Done',                color: '#10b981' },
    ],
  },
  {
    value: 'editing',
    label: 'Editing',
    defaultStatus: 'not_started',
    terminalStatus: 'done',
    statuses: [
      { value: 'not_started',    label: 'Not Started',     color: '#e05c6a' },
      { value: 'cutting',        label: 'Cutting',         color: '#7c3aed' },
      { value: 'color_polish',   label: 'Color and Polish',color: '#0ea5e9' },
      { value: 'in_review',      label: 'In Review',       color: '#6b7280' },
      { value: 'done',           label: 'Done',            color: '#10b981' },
      { value: 'making_changes', label: 'Making Changes',  color: '#f59e0b' },
    ],
  },
  {
    value: 'platform',
    label: 'Platform',
    defaultStatus: 'not_started',
    terminalStatus: 'ready_for_client',
    statuses: [
      { value: 'not_started',              label: 'Not Started',             color: '#6b7280' },
      { value: 'notes',                    label: 'NOTES',                   color: '#a78bfa' },
      { value: 'sent_to_robert',           label: 'Sent to Robert',          color: '#94a3b8' },
      { value: 'on_going',                 label: 'On Going',                color: '#c9a227' },
      { value: 'waiting_on_client',        label: 'Waiting on Client',       color: '#f59e0b' },
      { value: 'waiting_on_video_editing', label: 'Waiting on Video Editing',color: '#5a6478' },
      { value: 'waiting_on_blueprint',     label: 'Waiting on Blueprint',    color: '#3b82f6' },
      { value: 'loading_videos',           label: 'Loading Videos',          color: '#ec4899' },
      { value: 'ready_for_client',         label: 'Ready for Client',        color: '#34d399' },
    ],
  },
];

export const PHASE_MAP = new Map<TaskPhase, PhaseConfig>(
  PHASE_CONFIGS.map((c) => [c.value, c]),
);

export function getPhaseConfig(phase: TaskPhase): PhaseConfig {
  return PHASE_MAP.get(phase)!;
}

export function getStatusConfig(phase: TaskPhase, status: string): PhaseStatus | undefined {
  return getPhaseConfig(phase).statuses.find((s) => s.value === status);
}

export function getStatusLabel(phase: TaskPhase, status: string): string {
  return getStatusConfig(phase, status)?.label ?? status;
}

export function getStatusColor(phase: TaskPhase, status: string): string {
  return getStatusConfig(phase, status)?.color ?? '#6b7280';
}

export function isTerminalStatus(phase: TaskPhase, status: string): boolean {
  return getPhaseConfig(phase).terminalStatus === status;
}
