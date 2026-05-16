/**
 * Task type configs.
 *
 * NOTE: file name still says "task-phase" for git-history continuity, but the
 * concept is now "task type" (editing vs platform). The `TaskType` discriminator
 * replaces what was previously called `TaskPhase`. Pre-production has been removed
 * — that work moved to the People CRM.
 */

export type TaskType = 'editing' | 'platform';

export interface TaskTypeStatus {
  value: string;
  label: string;
  color: string;
}

export interface TaskTypeConfig {
  value: TaskType;
  label: string;
  statuses: TaskTypeStatus[];
  defaultStatus: string;
  terminalStatus: string;
}

export const TASK_TYPE_CONFIGS: TaskTypeConfig[] = [
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
    terminalStatus: 'done',
    // 12 statuses from the existing Monday board (NOTES pseudo-status dropped).
    statuses: [
      { value: 'not_started',              label: 'Not Started',             color: '#6b7280' },
      { value: 'working_on_it',            label: 'Working on it',           color: '#f59e0b' },
      { value: 'stuck',                    label: 'Stuck',                   color: '#e05c6a' },
      { value: 'in_review',                label: 'In Review',               color: '#94a3b8' },
      { value: 'done',                     label: 'Done',                    color: '#10b981' },
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

const TASK_TYPE_MAP = new Map<TaskType, TaskTypeConfig>(
  TASK_TYPE_CONFIGS.map((c) => [c.value, c]),
);

export function getTaskTypeConfig(taskType: TaskType): TaskTypeConfig {
  return TASK_TYPE_MAP.get(taskType)!;
}

export function getStatusConfig(taskType: TaskType, status: string): TaskTypeStatus | undefined {
  return getTaskTypeConfig(taskType).statuses.find((s) => s.value === status);
}

export function getStatusLabel(taskType: TaskType, status: string): string {
  return getStatusConfig(taskType, status)?.label ?? status;
}

export function getStatusColor(taskType: TaskType, status: string): string {
  return getStatusConfig(taskType, status)?.color ?? '#6b7280';
}

export function isTerminalStatus(taskType: TaskType, status: string): boolean {
  return getTaskTypeConfig(taskType).terminalStatus === status;
}
