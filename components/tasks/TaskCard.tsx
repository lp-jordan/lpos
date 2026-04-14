'use client';

import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task, TaskPriority } from '@/lib/models/task';
import { isTerminalStatus } from '@/lib/models/task-phase';
import type { UserSummary } from '@/lib/models/user';

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function Avatar({ user }: { user: UserSummary }) {
  const initials = user.name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return user.avatarUrl ? (
    <img className="task-card-avatar" src={user.avatarUrl} alt={user.name} title={user.name} />
  ) : (
    <span className="task-card-avatar task-card-avatar--initials" title={user.name}>
      {initials}
    </span>
  );
}

interface Props {
  task: Task;
  users: UserSummary[];
  commentCount: number;
  projectName: string | null;
  selected: boolean;
  isRenaming: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
}

export function TaskCard({
  task,
  users,
  commentCount,
  projectName,
  selected,
  isRenaming,
  onClick,
  onContextMenu,
  onRenameCommit,
  onRenameCancel,
}: Readonly<Props>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.taskId,
    data: { task },
    disabled: isRenaming,
  });

  const [renameValue, setRenameValue] = useState(task.description);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(task.description);
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [isRenaming, task.description]);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const isDone = isTerminalStatus(task.phase, task.status);
  const assignees = users.filter((u) => task.assignedTo.includes(u.id)).slice(0, 3);
  const showPriority = task.priority === 'urgent' || task.priority === 'high';

  function handleRenameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = renameValue.trim();
      if (val) onRenameCommit(val);
      else onRenameCancel();
    }
    if (e.key === 'Escape') onRenameCancel();
  }

  function handleRenameBlur() {
    const val = renameValue.trim();
    if (val && val !== task.description) onRenameCommit(val);
    else onRenameCancel();
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(isRenaming ? {} : listeners)}
      className={`task-card${isDone ? ' task-card--done' : ''}${selected ? ' task-card--selected' : ''}${isDragging ? ' task-card--dragging' : ''}${isRenaming ? ' task-card--renaming' : ''}`}
      onClick={isRenaming ? undefined : onClick}
      onContextMenu={isRenaming ? undefined : onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) onClick();
      }}
    >
      {isRenaming ? (
        <input
          ref={inputRef}
          className="task-card-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="task-card-title">{task.description}</div>
      )}

      {projectName && (
        <div className="task-card-project">
          {projectName}
        </div>
      )}

      <div className="task-card-footer">
        <div className="task-card-avatars">
          {assignees.map((u) => <Avatar key={u.id} user={u} />)}
          {task.assignedTo.length > 3 && (
            <span className="task-card-avatar task-card-avatar--overflow">+{task.assignedTo.length - 3}</span>
          )}
        </div>
        <div className="task-card-badges">
          {showPriority && (
            <span className={`task-priority-badge task-priority-badge--${task.priority}`}>
              {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          {commentCount > 0 && (
            <span className="task-card-comment-count" title={`${commentCount} comment${commentCount !== 1 ? 's' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {commentCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
