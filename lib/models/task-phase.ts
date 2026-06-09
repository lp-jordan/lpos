/**
 * Task type configs.
 *
 * NOTE: file name still says "task-phase" for git-history continuity, but the
 * concept is now "task type". The `TaskType` discriminator replaces what was
 * previously called `TaskPhase`. v21 adds 'preprod' (Pre-Production) back as a
 * THIRD task type, this time with admin-configurable columns sourced from the
 * `task_phase_configs` table — the static entry below is an empty placeholder
 * so getTaskTypeConfig doesn't throw; use resolveTaskTypeConfig() at the
 * render boundary to merge the DB-backed statuses in.
 *
 * Tab order in the dashboard mirrors the array order — Pre-Production comes
 * first by user request.
 */

export type TaskType = 'preprod' | 'editing' | 'platform';

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
    value: 'preprod',
    label: 'Pre-Production',
    // Dynamic — real statuses live in task_phase_configs (DB). The empty
    // arrays/strings here are a no-op fallback so static call sites don't
    // crash; render paths must call resolveTaskTypeConfig(taskType, statuses)
    // and pass in the live list fetched from /api/preprod-board/columns.
    defaultStatus: '',
    terminalStatus: '',
    statuses: [],
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

/**
 * Returns the effective TaskTypeConfig at render time. For 'preprod' the
 * statuses array comes from the DB and is passed in via context; for editing
 * and platform the static config is returned unchanged. terminalStatus is
 * intentionally left empty for preprod in v1 — no auto-completed-at behavior.
 */
export function resolveTaskTypeConfig(
  taskType: TaskType,
  dynamicPreprodStatuses?: TaskTypeStatus[],
): TaskTypeConfig {
  const base = getTaskTypeConfig(taskType);
  if (taskType !== 'preprod') return base;
  const statuses = dynamicPreprodStatuses ?? [];
  return {
    ...base,
    statuses,
    defaultStatus: statuses[0]?.value ?? '',
    terminalStatus: '',
  };
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
  const terminal = getTaskTypeConfig(taskType).terminalStatus;
  return terminal !== '' && terminal === status;
}
